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
  source: 'birdeye' | 'unknown';
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
    let detail: TokenDetail;
    try {
      const overview: any = await this.birdeye.tokenOverview(mint);
      detail = {
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
        source: overview ? 'birdeye' : 'unknown',
        fetchedAt: new Date().toISOString(),
      };
    } catch (err: any) {
      this.logger.warn(`tokenOverview failed for ${mint}: ${err?.message}`);
      detail = empty(mint);
    }

    this.cache.set(mint, { detail, ts: Date.now() });
    return detail;
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
