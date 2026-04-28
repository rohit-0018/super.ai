import { Injectable, Logger } from '@nestjs/common';
import { http, HttpError } from '../../common/http';

export interface CgCoinMarket {
  id: string;
  symbol: string;
  name: string;
  current_price: number | null;
  market_cap: number | null;
  market_cap_rank: number | null;
  price_change_percentage_24h: number | null;
  total_volume: number | null;
  image: string | null;
}

interface CacheEntry<T> {
  data: T;
  ts: number;
}

const TTL_MS = 60_000; // 60 s — well within CoinGecko free-tier limits

@Injectable()
export class CoinGeckoProvider {
  private readonly logger = new Logger(CoinGeckoProvider.name);
  private readonly base = 'https://api.coingecko.com/api/v3';
  private readonly headers: Record<string, string> = process.env.COINGECKO_API_KEY
    ? { 'x-cg-pro-api-key': process.env.COINGECKO_API_KEY }
    : {};

  private readonly cache = new Map<string, CacheEntry<unknown>>();

  private get<T>(cacheKey: string): T | null {
    const e = this.cache.get(cacheKey) as CacheEntry<T> | undefined;
    if (e && Date.now() - e.ts < TTL_MS) return e.data;
    return null;
  }

  private set<T>(cacheKey: string, data: T): void {
    this.cache.set(cacheKey, { data, ts: Date.now() });
  }

  /** Returns stale cache on rate-limit; returns empty on miss. */
  async price(ids: string[], vs = 'usd'): Promise<Record<string, { usd: number }>> {
    const key = `price:${ids.sort().join(',')}`;
    const cached = this.get<Record<string, { usd: number }>>(key);
    if (cached) return cached;

    try {
      const data = await http.get<Record<string, { usd: number }>>(`${this.base}/simple/price`, {
        headers: this.headers,
        timeoutMs: 8_000,
        params: { ids: ids.join(','), vs_currencies: vs },
      });
      this.set(key, data);
      return data;
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 0;
      if (status === 429) {
        this.logger.warn('CoinGecko rate limit hit — returning stale/empty price data');
        // Return stale data if we have any; fall back to empty map.
        const stale = this.cache.get(key) as CacheEntry<Record<string, { usd: number }>> | undefined;
        return stale?.data ?? {};
      }
      throw e;
    }
  }

  /** Full market data including price, change, volume, rank. */
  async markets(ids: string[]): Promise<CgCoinMarket[]> {
    if (!ids.length) return [];
    const key = `markets:${ids.sort().join(',')}`;
    const cached = this.get<CgCoinMarket[]>(key);
    if (cached) return cached;

    try {
      const data = await http.get<CgCoinMarket[]>(`${this.base}/coins/markets`, {
        headers: this.headers,
        timeoutMs: 10_000,
        params: {
          vs_currency: 'usd',
          ids: ids.join(','),
          order: 'market_cap_desc',
          per_page: ids.length,
          page: 1,
          sparkline: false,
        },
      });
      this.set(key, data);
      return data;
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 0;
      if (status === 429) {
        this.logger.warn('CoinGecko rate limit hit — returning stale/empty markets data');
        const stale = this.cache.get(key) as CacheEntry<CgCoinMarket[]> | undefined;
        return stale?.data ?? [];
      }
      throw e;
    }
  }

  async trending(): Promise<unknown> {
    const key = 'trending';
    const cached = this.get<unknown>(key);
    if (cached) return cached;

    try {
      const data = await http.get<unknown>(`${this.base}/search/trending`, {
        headers: this.headers,
        timeoutMs: 8_000,
      });
      this.set(key, data);
      return data;
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 0;
      if (status === 429) {
        const stale = this.cache.get(key);
        return stale?.data ?? { coins: [] };
      }
      throw e;
    }
  }

  async topMovers(limit = 25): Promise<unknown> {
    const key = `topMovers:${limit}`;
    const cached = this.get<unknown>(key);
    if (cached) return cached;

    try {
      const data = await http.get<unknown>(`${this.base}/coins/markets`, {
        headers: this.headers,
        timeoutMs: 8_000,
        params: { vs_currency: 'usd', order: 'price_change_percentage_24h_desc', per_page: limit, page: 1 },
      });
      this.set(key, data);
      return data;
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 0;
      if (status === 429) {
        const stale = this.cache.get(key);
        return stale?.data ?? [];
      }
      throw e;
    }
  }
}
