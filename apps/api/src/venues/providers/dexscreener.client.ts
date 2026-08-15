/**
 * Multi-chain DexScreener client.
 *
 * Supersedes token-analysis/providers/dexscreener.provider.ts for feed work.
 * That one hardcoded a Set of EVM chain names inline and collapsed every EVM
 * chain into one bucket, so a Base token and an Arbitrum token were
 * indistinguishable downstream. Here every row carries its precise ChainKey
 * resolved through the registry.
 *
 * Endpoints used (all free, no API key):
 *   token-boosts/latest/v1        60 req/min  — paid-boost tokens, all chains
 *   token-profiles/latest/v1      60 req/min  — newly profiled tokens, all chains
 *   tokens/v1/{chain}/{addrs}    300 req/min  — batch metadata, up to 30 addrs
 *   latest/dex/search?q=         300 req/min  — symbol/name search, all chains
 *   token-pairs/v1/{chain}/{a}   300 req/min  — every pool for one token
 *
 * We deliberately prefer `tokens/v1` over the legacy `latest/dex/tokens/{addr}`:
 * the legacy route is one-address-per-call, while tokens/v1 takes 30. For a
 * scanner sweeping 9 chains that is the difference between ~270 calls and ~9.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  ALL_CHAINS,
  fromDexScreener,
  getChain,
  type ChainKey,
  type ChainSpec,
} from '../chain-registry';
import type { FeedToken } from '../venue.types';

const BASE = 'https://api.dexscreener.com';

/** DexScreener caps batch lookups at 30 addresses per call. */
const MAX_BATCH = 30;

export interface DexPair {
  chainId: string;
  dexId?: string;
  url?: string;
  pairAddress?: string;
  labels?: string[];
  baseToken?: { address?: string; name?: string; symbol?: string };
  quoteToken?: { address?: string; name?: string; symbol?: string };
  priceUsd?: string;
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
  txns?: Record<string, { buys?: number; sells?: number }>;
  volume?: { h24?: number; h6?: number; h1?: number; m5?: number };
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: { imageUrl?: string; socials?: unknown[]; websites?: unknown[] };
}

@Injectable()
export class DexScreenerClient {
  private readonly logger = new Logger(DexScreenerClient.name);

  /**
   * Boosted + profiled tokens across every chain we know.
   * These two endpoints are the cheapest broad discovery surface DexScreener
   * offers — two calls return the full cross-chain candidate set.
   */
  async discoverAcrossChains(): Promise<Array<{ chain: ChainSpec; address: string; source: string }>> {
    const [boosts, profiles] = await Promise.all([
      this.getJson<any[]>(`${BASE}/token-boosts/latest/v1`, 5_000).catch(() => []),
      this.getJson<any[]>(`${BASE}/token-profiles/latest/v1`, 5_000).catch(() => []),
    ]);

    const out = new Map<string, { chain: ChainSpec; address: string; source: string }>();

    const ingest = (rows: any[] | null, source: string) => {
      for (const r of rows ?? []) {
        const chain = fromDexScreener(r?.chainId);
        // Unknown chain => a chain we have not registered. Skipping is correct:
        // we cannot price, link, or trade it, so surfacing it would be a dead row.
        if (!chain || !r?.tokenAddress) continue;
        const k = `${chain.key}:${r.tokenAddress.toLowerCase()}`;
        if (!out.has(k)) out.set(k, { chain, address: r.tokenAddress, source });
      }
    };

    ingest(Array.isArray(boosts) ? boosts : [], 'dexscreener_boost');
    ingest(Array.isArray(profiles) ? profiles : [], 'dexscreener_profile');

    return [...out.values()];
  }

  /**
   * Batch-hydrate addresses on one chain. Returns the highest-liquidity pair
   * per token, which is the pool a router will actually trade against.
   */
  async pairsForTokens(chain: ChainSpec, addresses: string[]): Promise<Map<string, DexPair>> {
    const best = new Map<string, DexPair>();
    if (!addresses.length) return best;

    const batches: string[][] = [];
    for (let i = 0; i < addresses.length; i += MAX_BATCH) {
      batches.push(addresses.slice(i, i + MAX_BATCH));
    }

    const results = await Promise.all(
      batches.map((b) =>
        this.getJson<DexPair[]>(
          `${BASE}/tokens/v1/${chain.ids.dexscreener}/${b.join(',')}`,
          4_000,
        ).catch(() => null),
      ),
    );

    for (const pairs of results) {
      for (const p of pairs ?? []) {
        const addr = p?.baseToken?.address?.toLowerCase();
        if (!addr) continue;
        const prev = best.get(addr);
        if (!prev || (p.liquidity?.usd ?? 0) > (prev.liquidity?.usd ?? 0)) {
          best.set(addr, p);
        }
      }
    }
    return best;
  }

  /** Every pool for a single token, newest-liquidity-first. */
  async poolsForToken(chain: ChainSpec, address: string): Promise<DexPair[]> {
    const pairs = await this.getJson<DexPair[]>(
      `${BASE}/token-pairs/v1/${chain.ids.dexscreener}/${address}`,
      4_000,
    ).catch(() => null);
    return (pairs ?? []).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  }

  /**
   * Free-text search across all chains. Powers "type WIF, get every listing".
   * Optionally narrowed to one chain.
   */
  async search(query: string, chain?: ChainKey): Promise<FeedToken[]> {
    const body = await this.getJson<{ pairs?: DexPair[] }>(
      `${BASE}/latest/dex/search?q=${encodeURIComponent(query)}`,
      5_000,
    ).catch(() => null);

    const pairs = body?.pairs ?? [];
    const rows: FeedToken[] = [];
    for (const p of pairs) {
      const spec = fromDexScreener(p.chainId);
      if (!spec) continue;
      if (chain && spec.key !== chain) continue;
      const t = this.toFeedToken(spec, p, 'dexscreener_search');
      if (t) rows.push(t);
    }
    // Same token can list on many pools; keep the deepest per (chain, address).
    return dedupeByLiquidity(rows);
  }

  /**
   * Normalizes a DexScreener pair into our chain-tagged feed row.
   * Returns null when the pair is missing the fields that make it actionable.
   */
  toFeedToken(chain: ChainSpec, p: DexPair, source: string): FeedToken | null {
    const address = p.baseToken?.address;
    if (!address) return null;

    const priceUsd = num(p.priceUsd);
    if (priceUsd == null) return null;

    return {
      chain: chain.key,
      chainName: chain.displayName,
      address,
      symbol: p.baseToken?.symbol ?? '???',
      name: p.baseToken?.name ?? 'Unknown',
      priceUsd,
      priceChange5m: p.priceChange?.m5,
      priceChange1h: p.priceChange?.h1,
      priceChange24h: p.priceChange?.h24,
      volume24hUsd: p.volume?.h24 ?? 0,
      liquidityUsd: p.liquidity?.usd ?? 0,
      marketCapUsd: p.marketCap,
      fdvUsd: p.fdv,
      pairAddress: p.pairAddress,
      pairAgeHours: p.pairCreatedAt
        ? Math.max(0, (Date.now() - p.pairCreatedAt) / 3_600_000)
        : undefined,
      dex: p.dexId,
      buys24h: p.txns?.h24?.buys,
      sells24h: p.txns?.h24?.sells,
      source,
      dexUrl: p.url,
      imageUrl: p.info?.imageUrl,
      // Every registered chain has a router wired, so anything that resolves
      // through the registry is tradable by construction.
      tradable: true,
    };
  }

  /** Chains DexScreener knows that we have registered. */
  supportedChains(): ChainKey[] {
    return ALL_CHAINS.map((c) => c.key);
  }

  chainSpec(key: ChainKey): ChainSpec {
    return getChain(key);
  }

  private async getJson<T>(url: string, timeoutMs: number): Promise<T | null> {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'qwai/1.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        if (res.status !== 429) {
          this.logger.warn(`DexScreener ${res.status} for ${url.slice(0, 90)}`);
        }
        return null;
      }
      return (await res.json()) as T;
    } catch (e: any) {
      this.logger.warn(`DexScreener fetch failed: ${e?.message}`);
      return null;
    }
  }
}

export function dedupeByLiquidity(rows: FeedToken[]): FeedToken[] {
  const best = new Map<string, FeedToken>();
  for (const r of rows) {
    const k = `${r.chain}:${r.address.toLowerCase()}`;
    const prev = best.get(k);
    if (!prev || r.liquidityUsd > prev.liquidityUsd) best.set(k, r);
  }
  return [...best.values()];
}

function num(v: unknown): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
