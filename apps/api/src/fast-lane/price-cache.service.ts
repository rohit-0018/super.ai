import { Injectable, Logger, OnModuleInit, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MarketDataService } from '../market-data/market-data.service';

interface CachedPrice {
  price: number;
  source: string;   // "birdeye" | "coingecko" | "jupiter" | "manual"
  updatedAt: number; // epoch ms
}

export interface PriceCacheEntry {
  token: string;
  price: number;
  source: string;
  ageMs: number;
}

@Injectable()
export class PriceCacheService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PriceCacheService.name);
  private readonly cache = new Map<string, CachedPrice>();
  private readonly ttlMs: number;
  private readonly skipQuoteIfFresh: boolean;
  private refreshInterval?: NodeJS.Timeout;
  private readonly refreshIntervalMs = 3000; // re-fetch every 3s
  private readonly maxCacheSize = 500;

  /** Tokens we actively refresh in the background (hot set) */
  private readonly hotTokens = new Set<string>();

  constructor(
    private config: ConfigService,
    private marketData: MarketDataService,
  ) {
    this.ttlMs = parseInt(config.get<string>('FAST_LANE_PRICE_CACHE_TTL_MS', '5000'), 10);
    this.skipQuoteIfFresh = config.get<string>('FAST_LANE_SKIP_QUOTE_IF_FRESH', 'true') === 'true';
  }

  async onModuleInit(): Promise<void> {
    // Start background refresh loop for hot tokens
    this.refreshInterval = setInterval(() => {
      this.refreshHotTokens().catch((e) => {
        this.logger.warn(`Hot token refresh failed: ${e.message}`);
      });
    }, this.refreshIntervalMs);
    this.refreshInterval.unref();
    this.logger.log(`PriceCacheService initialized (ttl=${this.ttlMs}ms, skipQuoteIfFresh=${this.skipQuoteIfFresh})`);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = undefined;
    }
  }

  isSkipQuoteEnabled(): boolean {
    return this.skipQuoteIfFresh;
  }

  getTtlMs(): number {
    return this.ttlMs;
  }

  /**
   * Get the cached price for a token.
   * Returns null if not cached or stale (older than TTL).
   */
  get(token: string): PriceCacheEntry | null {
    const entry = this.cache.get(token);
    if (!entry) return null;

    const ageMs = Date.now() - entry.updatedAt;
    if (ageMs > this.ttlMs) {
      return null; // stale
    }
    return {
      token,
      price: entry.price,
      source: entry.source,
      ageMs,
    };
  }

  /**
   * Set a cached price. Called by market data subscribers / background refresh.
   * Also adds token to hot set so it gets refreshed on an interval.
   */
  set(token: string, price: number, source: string = 'manual'): void {
    if (this.cache.size >= this.maxCacheSize && !this.cache.has(token)) {
      // Evict oldest entry
      const oldestKey = this.findOldestKey();
      if (oldestKey) this.cache.delete(oldestKey);
    }
    this.cache.set(token, {
      price,
      source,
      updatedAt: Date.now(),
    });
    this.hotTokens.add(token);
  }

  /**
   * Check if a price is fresh enough to skip the quote fetch.
   */
  isFresh(token: string, maxAgeMs?: number): boolean {
    const entry = this.cache.get(token);
    if (!entry) return false;
    const ageLimit = maxAgeMs ?? this.ttlMs;
    return Date.now() - entry.updatedAt <= ageLimit;
  }

  /**
   * Compute the minimum output amount for a swap using cached price + slippage.
   * Returns null if no fresh price available.
   */
  computeMinOut(token: string, amountInUsd: number, slippageBps: number): number | null {
    const entry = this.get(token);
    if (!entry) return null;

    const expectedOut = amountInUsd / entry.price;
    const slippageFraction = slippageBps / 10000;
    const minOut = expectedOut * (1 - slippageFraction);
    return minOut;
  }

  /**
   * Fetch price from market data and cache it.
   * Used as a fallback when cache miss occurs.
   */
  async fetchAndCache(token: string): Promise<number | null> {
    try {
      const price = await this.marketData.price(token);
      if (price === null || price === undefined) return null;

      // Determine source from token format
      const source = token.length > 30 ? 'birdeye' : 'coingecko';
      this.set(token, price, source);
      return price;
    } catch (err: any) {
      this.logger.warn(`Failed to fetch price for ${token}: ${err.message}`);
      return null;
    }
  }

  /**
   * Get a fresh price: try cache first, fall back to market data fetch.
   */
  async getOrFetch(token: string): Promise<number | null> {
    const cached = this.get(token);
    if (cached) return cached.price;
    return this.fetchAndCache(token);
  }

  /**
   * Return snapshot of all cached entries for debugging/metrics.
   */
  snapshot(): PriceCacheEntry[] {
    const now = Date.now();
    return Array.from(this.cache.entries()).map(([token, entry]) => ({
      token,
      price: entry.price,
      source: entry.source,
      ageMs: now - entry.updatedAt,
    }));
  }

  /** Clear all cached prices (testing utility) */
  clear(): void {
    this.cache.clear();
    this.hotTokens.clear();
  }

  /** Get hot tokens being refreshed in background */
  getHotTokens(): string[] {
    return Array.from(this.hotTokens);
  }

  // ─── Private ───

  private async refreshHotTokens(): Promise<void> {
    if (this.hotTokens.size === 0) return;
    const tokens = Array.from(this.hotTokens);

    // Parallel fetch — cap concurrency to avoid hammering market data APIs
    const BATCH_SIZE = 10;
    for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
      const batch = tokens.slice(i, i + BATCH_SIZE);
      await Promise.allSettled(batch.map((t) => this.fetchAndCache(t)));
    }
  }

  private findOldestKey(): string | null {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of this.cache) {
      if (entry.updatedAt < oldestTime) {
        oldestTime = entry.updatedAt;
        oldestKey = key;
      }
    }
    return oldestKey;
  }
}
