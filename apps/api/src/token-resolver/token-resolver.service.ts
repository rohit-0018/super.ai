import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { BoundedCache } from '../common/bounded-cache';
import { DexScreenerProvider, DexSearchPair } from '../token-analysis/providers/dexscreener.provider';
import { CoinGeckoProvider } from '../market-data/providers/coingecko.provider';
import { classifyInput } from './input-classifier';
import { scoreToken, sortCandidates, computeConfidence, MATCH_TIER_RANK } from './ranking';
import type {
  Chain,
  MatchTier,
  ResolvedToken,
  ResolveOptions,
  ResolveResult,
} from './token-resolver.types';

const EVM_CHAINS = new Set([
  'ethereum', 'bsc', 'base', 'arbitrum', 'optimism', 'polygon',
  'avalanche', 'zksync', 'linea', 'blast', 'scroll', 'mantle',
  'fantom', 'cronos', 'gnosis', 'celo', 'moonbeam', 'aurora',
]);

function chainIdToChain(chainId: string): Chain | null {
  if (chainId === 'solana') return 'SOLANA';
  if (EVM_CHAINS.has(chainId)) return 'EVM';
  return null;
}

const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * #1 must have at least this many times the runner-up's liquidity to auto-pick
 * when a real second contender exists. Score-confidence is log-compressed and
 * useless as a gate (a 300x bigger token still scores within ~20%), so the
 * trade guard keys off raw liquidity dominance instead.
 */
export const TRADE_DOMINANCE_RATIO = 3;
/** A trade target (or a "real" runner-up) needs at least this much liquidity. */
export const TRADE_MIN_LIQUIDITY_USD = 5_000;

const EMPTY = (kind: ResolveResult['kind'], query: string): ResolveResult => ({
  kind, query, best: null, candidates: [], ambiguous: false, confidence: 0,
});

@Injectable()
export class TokenResolverService {
  private readonly logger = new Logger(TokenResolverService.name);
  // One DexScreener call per uncached ticker; 90s TTL keeps us well under the
  // 300/min soft limit. Negative results share the same TTL — acceptable since
  // brand-new tokens are pasted as addresses, not searched by ticker.
  private readonly cache = new BoundedCache<string, ResolveResult>(500, 90_000);

  constructor(
    private readonly dex: DexScreenerProvider,
    private readonly cg: CoinGeckoProvider,
  ) {}

  async resolve(input: string, opts: ResolveOptions = {}): Promise<ResolveResult> {
    const limit = opts.limit ?? 8;
    const classified = classifyInput(input);

    if (classified.kind === 'unresolvable') return EMPTY('unresolvable', (input ?? '').trim());

    if (classified.kind === 'address') {
      return this.resolveAddress(classified.chain, classified.value);
    }

    return this.resolveTicker(classified.symbol, { ...opts, limit });
  }

  /**
   * Resolve for a money-moving path (swap / order / auto-trade / alert).
   * Policy (locked): auto-pick the top-ranked token and echo it back, but
   * never silently trade something dangerous —
   *   • nothing resolves            → 400
   *   • ambiguous & low confidence  → 409 { reason:'ambiguous_ticker', candidates }
   *   • top pick below liq floor    → 409 { reason:'low_liquidity', candidates }
   * The web confirm chip enforces the human check; this 409 is the contract
   * for raw API callers so they can show the picker instead of buying a scam.
   */
  async resolveForTrade(input: string, opts: ResolveOptions = {}): Promise<ResolvedToken> {
    const r = await this.resolve(input, opts);

    if (r.kind === 'unresolvable' || !r.best) {
      throw new BadRequestException({
        message: `Could not resolve a token for "${input}". Pass a contract address or a $TICKER.`,
      });
    }
    if (r.kind === 'address') return r.best;

    // Ambiguous only when a *real* runner-up (≥ liquidity floor, same match
    // tier) exists and #1 isn't clearly bigger. A 300x-deeper pool auto-picks.
    const second = r.candidates[1];
    const topLiq = r.best.liquidityUsd ?? 0;
    const secondLiq = second?.liquidityUsd ?? 0;
    const realContender =
      !!second &&
      second.matchTier === r.best.matchTier &&
      secondLiq >= TRADE_MIN_LIQUIDITY_USD;
    if (realContender && topLiq < TRADE_DOMINANCE_RATIO * secondLiq) {
      throw new ConflictException({
        message: `"$${r.query.toUpperCase()}" is ambiguous — pick the exact token.`,
        reason: 'ambiguous_ticker',
        query: r.query,
        candidates: r.candidates,
      });
    }
    if (topLiq < TRADE_MIN_LIQUIDITY_USD) {
      throw new ConflictException({
        message: `Top match for "$${r.query.toUpperCase()}" has very low liquidity ($${Math.round(
          r.best.liquidityUsd ?? 0,
        )}). Confirm the contract address.`,
        reason: 'low_liquidity',
        query: r.query,
        candidates: r.candidates,
      });
    }
    return r.best;
  }

  // ── Address path ────────────────────────────────────────────────────────────
  // The user gave an exact address. Enrich with DexScreener for symbol/metrics,
  // but never block: a token too new to be on DexScreener still resolves to a
  // usable stub so the caller can proceed to scan it.
  private async resolveAddress(chain: Chain, address: string): Promise<ResolveResult> {
    const meta = await this.dex.getToken(chain, address).catch(() => null);
    const token: ResolvedToken = {
      chain,
      chainId: meta?.chainId ?? (chain === 'SOLANA' ? 'solana' : 'ethereum'),
      address,
      symbol: meta?.symbol ?? '',
      name: meta?.name ?? '',
      priceUsd: num(meta?.priceUsd),
      liquidityUsd: num(meta?.liquidityUsd),
      volume24hUsd: num(meta?.volume24hUsd),
      marketCapUsd: num(meta?.marketCapUsd),
      fdvUsd: num(meta?.fdvUsd),
      pairAgeHours: num(meta?.pairAgeHours),
      txns24h: meta?.txns24h ? (meta.txns24h.buys ?? 0) + (meta.txns24h.sells ?? 0) : null,
      logoURI: null,
      url: meta?.url ?? null,
      verified: false,
      score: 0,
      matchTier: 'address',
    };
    return { kind: 'address', query: address, best: token, candidates: [token], ambiguous: false, confidence: 1 };
  }

  // ── Ticker path ─────────────────────────────────────────────────────────────
  private async resolveTicker(symbol: string, opts: ResolveOptions): Promise<ResolveResult> {
    const q = symbol.toLowerCase();
    const cacheKey = `tk:${opts.chain ?? 'any'}:${q}:${opts.limit}:${opts.minLiquidityUsd ?? 0}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    // DexScreener is the source of truth; CoinGecko only flags "verified".
    const [pairs, cgCoins] = await Promise.all([
      this.dex.search(symbol),
      this.cg.searchBySymbol(symbol).catch(() => []),
    ]);

    const verifiedSymbols = new Set(
      cgCoins.map((c) => (c.symbol ?? '').toLowerCase()).filter(Boolean),
    );

    const collapsed = this.collapsePairs(pairs, q, opts);
    let candidates: ResolvedToken[] = collapsed.map((t) => {
      const verified = verifiedSymbols.has(t.symbol.toLowerCase());
      return {
        ...t,
        verified,
        score: scoreToken({
          liquidityUsd: t.liquidityUsd,
          volume24hUsd: t.volume24hUsd,
          marketCapUsd: t.marketCapUsd,
          txns24h: t.txns24h,
          pairAgeHours: t.pairAgeHours,
          verified,
        }),
      };
    });

    candidates = sortCandidates(candidates).slice(0, opts.limit);
    const result: ResolveResult = {
      kind: 'ticker',
      query: symbol,
      best: candidates[0] ?? null,
      candidates,
      ambiguous: candidates.length > 1,
      confidence: computeConfidence(candidates),
    };
    this.cache.set(cacheKey, result);
    this.logger.debug(
      `resolve "$${symbol}" → ${candidates.length} candidate(s)` +
        (result.best ? `, top=${result.best.symbol}/${result.best.chain} ` +
          `liq=$${Math.round(result.best.liquidityUsd ?? 0)} conf=${result.confidence.toFixed(2)}` : ', none'),
    );
    return result;
  }

  /**
   * Filter loose/quote/junk matches, then collapse the many pools a token
   * trades in into one ranked candidate per (chain, address). Same symbol on
   * different chains stays distinct — those are the "multiples" we surface.
   */
  private collapsePairs(
    pairs: DexSearchPair[],
    q: string,
    opts: ResolveOptions,
  ): Omit<ResolvedToken, 'verified' | 'score'>[] {
    const byToken = new Map<string, DexSearchPair[]>();

    for (const p of pairs) {
      const chain = chainIdToChain(p.chainId);
      if (!chain) continue;
      if (opts.chain && chain !== opts.chain) continue;

      const sym = (p.baseToken.symbol ?? '').toLowerCase();
      const name = (p.baseToken.name ?? '').toLowerCase();
      // Must match the base token (the thing being priced), not the quote.
      const tier = matchTier(sym, name, q);
      if (!tier) continue;

      const liq = num(p.liquidity?.usd) ?? 0;
      const vol = num(p.volume?.h24) ?? 0;
      const tx =
        (p.txns?.h24?.buys ?? 0) + (p.txns?.h24?.sells ?? 0);
      if (liq <= 0 && vol <= 0 && tx <= 0) continue; // dead pool

      const key = `${p.chainId}:${p.baseToken.address.toLowerCase()}`;
      const arr = byToken.get(key);
      if (arr) arr.push(p);
      else byToken.set(key, [p]);
    }

    const out: Omit<ResolvedToken, 'verified' | 'score'>[] = [];
    for (const [, group] of byToken) {
      const chain = chainIdToChain(group[0].chainId)!;
      // Representative pool = deepest liquidity (best price/url/logo source).
      const rep = [...group].sort(
        (a, b) => (num(b.liquidity?.usd) ?? 0) - (num(a.liquidity?.usd) ?? 0),
      )[0];

      const liquidityUsd = sum(group, (p) => num(p.liquidity?.usd));
      const volume24hUsd = sum(group, (p) => num(p.volume?.h24));
      const txns24h = group.reduce(
        (s, p) => s + (p.txns?.h24?.buys ?? 0) + (p.txns?.h24?.sells ?? 0),
        0,
      );
      const marketCapUsd = maxOf(group, (p) => num(p.marketCap));
      const fdvUsd = maxOf(group, (p) => num(p.fdv));
      const earliestCreatedAt = group
        .map((p) => p.pairCreatedAt)
        .filter((t): t is number => typeof t === 'number' && t > 0)
        .sort((a, b) => a - b)[0];
      const pairAgeHours = earliestCreatedAt
        ? Math.max(0, (Date.now() - earliestCreatedAt) / 3_600_000)
        : null;

      const bestTier = group
        .map((p) =>
          matchTier(
            (p.baseToken.symbol ?? '').toLowerCase(),
            (p.baseToken.name ?? '').toLowerCase(),
            q,
          ),
        )
        .filter((t): t is Exclude<MatchTier, 'address'> => !!t)
        .sort((a, b) => MATCH_TIER_RANK[b] - MATCH_TIER_RANK[a])[0];

      const cand: Omit<ResolvedToken, 'verified' | 'score'> = {
        chain,
        chainId: rep.chainId,
        address: rep.baseToken.address,
        symbol: rep.baseToken.symbol ?? '',
        name: rep.baseToken.name ?? '',
        priceUsd: num(rep.priceUsd),
        liquidityUsd,
        volume24hUsd,
        marketCapUsd,
        fdvUsd,
        pairAgeHours,
        txns24h,
        logoURI: rep.info?.imageUrl ?? null,
        url: rep.url ?? null,
        matchTier: bestTier ?? 'fuzzy',
      };

      if (opts.minLiquidityUsd != null && (liquidityUsd ?? 0) < opts.minLiquidityUsd) {
        continue;
      }
      out.push(cand);
    }
    return out;
  }
}

function matchTier(symbol: string, name: string, q: string): Exclude<MatchTier, 'address'> | null {
  if (symbol === q) return 'exact';
  if (symbol.startsWith(q)) return 'prefix';
  if (symbol.includes(q) || name.includes(q)) return 'fuzzy';
  return null;
}

function sum(arr: DexSearchPair[], pick: (p: DexSearchPair) => number | null): number | null {
  let total = 0;
  let any = false;
  for (const p of arr) {
    const v = pick(p);
    if (v != null) {
      total += v;
      any = true;
    }
  }
  return any ? total : null;
}

function maxOf(arr: DexSearchPair[], pick: (p: DexSearchPair) => number | null): number | null {
  let m: number | null = null;
  for (const p of arr) {
    const v = pick(p);
    if (v != null && (m == null || v > m)) m = v;
  }
  return m;
}
