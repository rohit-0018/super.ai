import { Injectable, Logger } from '@nestjs/common';
import { BirdeyeProvider } from './providers/birdeye.provider';

export interface TokenDetail {
  mint: string;
  name: string | null;
  symbol: string | null;
  logoURI: string | null;
  decimals: number | null;
  priceUsd: number | null;
  priceChange24hPct: number | null;
  marketCap: number | null;
  fdv: number | null;
  liquidity: number | null;
  volume24hUsd: number | null;
  supply: number | null;
  holders: number | null;
  source: 'birdeye' | 'dexscreener' | 'unknown';
  fetchedAt: string;
}

interface CacheEntry {
  detail: TokenDetail;
  ts: number;
}

@Injectable()
export class TokenMetadataService {
  private readonly logger = new Logger(TokenMetadataService.name);

  // Single TTL for the whole detail blob — Birdeye returns everything in one call,
  // so caching only the static half doesn't save a round-trip. 60s is the right
  // floor for "current price/mcap" freshness in a portfolio view.
  private readonly TTL_MS = 60_000;

  private cache = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<TokenDetail>>();

  constructor(private birdeye: BirdeyeProvider) {}

  async get(mint: string): Promise<TokenDetail> {
    const cached = this.cache.get(mint);
    if (cached && Date.now() - cached.ts < this.TTL_MS) return cached.detail;

    const inflight = this.inflight.get(mint);
    if (inflight) return inflight;

    const p = this.fetch(mint).finally(() => this.inflight.delete(mint));
    this.inflight.set(mint, p);
    return p;
  }

  private async fetch(mint: string): Promise<TokenDetail> {
    // Try Birdeye first if we have a key — it has supply/holders/FDV which
    // DexScreener does not. If no key, or Birdeye returns nothing useful,
    // fall back to DexScreener (free, no key, covers price/mcap/liq/vol/24h).
    let detail = await this.fetchFromBirdeye(mint);
    if (!detail || detail.priceUsd == null) {
      const dex = await this.fetchFromDexScreener(mint);
      if (dex && dex.priceUsd != null) {
        // Merge: keep birdeye-only fields if we got them, layer DexScreener over the rest.
        detail = detail
          ? { ...detail, ...dex, supply: detail.supply ?? dex.supply, holders: detail.holders ?? dex.holders, fdv: detail.fdv ?? dex.fdv, source: 'dexscreener' }
          : dex;
      }
    }
    if (!detail) detail = empty(mint);
    this.cache.set(mint, { detail, ts: Date.now() });
    return detail;
  }

  private async fetchFromBirdeye(mint: string): Promise<TokenDetail | null> {
    if (!process.env.BIRDEYE_API_KEY) return null;
    try {
      const overview: any = await this.birdeye.tokenOverview(mint);
      if (!overview) return null;
      return {
        mint,
        name: overview?.name ?? null,
        symbol: overview?.symbol ?? null,
        logoURI: overview?.logoURI ?? null,
        decimals: typeof overview?.decimals === 'number' ? overview.decimals : null,
        priceUsd: numOrNull(overview?.price),
        priceChange24hPct: numOrNull(overview?.priceChange24hPercent),
        marketCap: numOrNull(overview?.mc ?? overview?.marketCap),
        fdv: numOrNull(overview?.fdv),
        liquidity: numOrNull(overview?.liquidity),
        volume24hUsd: numOrNull(overview?.v24hUSD ?? overview?.volume24hUSD),
        supply: numOrNull(overview?.supply ?? overview?.totalSupply),
        holders: numOrNull(overview?.holder ?? overview?.holders),
        source: 'birdeye',
        fetchedAt: new Date().toISOString(),
      };
    } catch (err: any) {
      this.logger.warn(`birdeye tokenOverview failed for ${mint}: ${err?.message}`);
      return null;
    }
  }

  /**
   * Free fallback. DexScreener returns the deepest pair for the mint along
   * with full market data. No API key required, ~50ms typical.
   */
  private async fetchFromDexScreener(mint: string): Promise<TokenDetail | null> {
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return null;
      const json: any = await res.json();
      const pairs: any[] = Array.isArray(json?.pairs) ? json.pairs : [];
      if (pairs.length === 0) return null;
      // Pick the pair with highest liquidity — that's the "real" market.
      const best = pairs.reduce((a, b) => ((b?.liquidity?.usd ?? 0) > (a?.liquidity?.usd ?? 0) ? b : a));
      const baseToken = best?.baseToken ?? {};
      return {
        mint,
        name: baseToken?.name ?? null,
        symbol: baseToken?.symbol ?? null,
        logoURI: best?.info?.imageUrl ?? null,
        decimals: null,
        priceUsd: numOrNull(best?.priceUsd),
        priceChange24hPct: numOrNull(best?.priceChange?.h24),
        marketCap: numOrNull(best?.marketCap ?? best?.fdv),
        fdv: numOrNull(best?.fdv),
        liquidity: numOrNull(best?.liquidity?.usd),
        volume24hUsd: numOrNull(best?.volume?.h24),
        supply: null,
        holders: null,
        source: 'dexscreener',
        fetchedAt: new Date().toISOString(),
      };
    } catch (err: any) {
      this.logger.warn(`dexscreener fallback failed for ${mint}: ${err?.message}`);
      return null;
    }
  }
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function empty(mint: string): TokenDetail {
  return {
    mint,
    name: null,
    symbol: null,
    logoURI: null,
    decimals: null,
    priceUsd: null,
    priceChange24hPct: null,
    marketCap: null,
    fdv: null,
    liquidity: null,
    volume24hUsd: null,
    supply: null,
    holders: null,
    source: 'unknown',
    fetchedAt: new Date().toISOString(),
  };
}
