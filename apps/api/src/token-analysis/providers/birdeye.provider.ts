import { Injectable, Logger } from '@nestjs/common';
import { HttpError, http } from '../../common/http';
import type { PriceImpact } from '../token-analysis.types';

export interface BirdeyeTokenOverview {
  traderCount24h: number | null;  // unique wallets trading in 24h
  buyCount24h: number | null;
  sellCount24h: number | null;
  volume24h: number | null;
  priceChange24h: number | null;
}

/**
 * Birdeye API — free tier (10 req/min, API key required).
 * Provides: price impact simulation, unique trader count, OHLCV.
 *
 * Get key: https://birdeye.so (free signup → API section)
 * Docs: https://public-api.birdeye.so
 */
@Injectable()
export class BirdeyeProvider {
  private readonly logger = new Logger(BirdeyeProvider.name);
  private readonly base = 'https://public-api.birdeye.so';
  private readonly apiKey: string | null;

  constructor() {
    this.apiKey = process.env.BIRDEYE_API_KEY ?? null;
    if (!this.apiKey) {
      this.logger.warn('BIRDEYE_API_KEY not set — Birdeye disabled');
    }
  }

  get isAvailable(): boolean { return !!this.apiKey; }

  private get headers(): Record<string, string> {
    return { 'X-API-KEY': this.apiKey!, 'x-chain': 'solana' };
  }

  async getTokenOverview(address: string): Promise<BirdeyeTokenOverview | null> {
    if (!this.apiKey) return null;
    try {
      const data = await http.get<any>(`${this.base}/defi/token_overview`, {
        params: { address },
        headers: this.headers,
        timeoutMs: 8_000,
      });
      const d = data?.data;
      if (!d) return null;

      return {
        traderCount24h: numOrNull(d.uniqueWallet24h),
        buyCount24h: numOrNull(d.buy24h),
        sellCount24h: numOrNull(d.sell24h),
        volume24h: numOrNull(d.v24hUSD),
        priceChange24h: numOrNull(d.priceChange24hPercent),
      };
    } catch (e: any) {
      if (e instanceof HttpError && e.status === 429) throw e;
      if (e instanceof HttpError && e.status === 404) return null;
      this.logger.warn(`Birdeye overview failed for ${address}: ${e.message}`);
      return null;
    }
  }

  /**
   * Simulate price impact for buy at $500, $1K, $5K.
   * Uses the price impact endpoint which returns simulated slippage.
   */
  async getPriceImpact(address: string): Promise<PriceImpact | null> {
    if (!this.apiKey) return null;
    try {
      const sizes = [500, 1000, 5000];
      const results = await Promise.allSettled(
        sizes.map((usdAmt) =>
          http.get<any>(`${this.base}/defi/price_impact`, {
            params: { address, trade_type: 'buy', type: '15m', tx_amount: String(usdAmt) },
            headers: this.headers,
            timeoutMs: 8_000,
          }),
        ),
      );

      const [r500, r1000, r5000] = results.map((r) => {
        if (r.status !== 'fulfilled') return null;
        const val = r.value?.data?.priceImpact;
        return typeof val === 'number' ? Math.abs(val) : null;
      });

      if (r500 === null && r1000 === null && r5000 === null) return null;

      return {
        buy500Usd: r500 ?? undefined,
        buy1000Usd: r1000 ?? undefined,
        buy5000Usd: r5000 ?? undefined,
      };
    } catch (e: any) {
      if (e instanceof HttpError && e.status === 429) throw e;
      this.logger.warn(`Birdeye price impact failed for ${address}: ${e.message}`);
      return null;
    }
  }
}

function numOrNull(v: any): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
