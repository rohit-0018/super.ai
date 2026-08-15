/**
 * Hyperliquid perps market data.
 *
 * The single best free perps source available: no API key, no rate-limit
 * headaches, and one POST returns the entire perp universe with funding, open
 * interest, mark and oracle price. Verified live against
 * `POST https://api.hyperliquid.xyz/info {"type":"metaAndAssetCtxs"}`.
 *
 * Funding on Hyperliquid settles HOURLY, unlike the 8-hour interval used by
 * Binance and Bybit. Comparing the raw `funding` field across venues is
 * therefore meaningless — an 0.0001 hourly rate is 8x an 0.0001 8-hourly rate.
 * Everything is normalized to APR before it leaves this adapter.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { PerpMarket, VenueAdapter, VenueCapabilities } from '../venue.types';
import type { ChainKey } from '../chain-registry';

const INFO_URL = 'https://api.hyperliquid.xyz/info';
const FUNDING_INTERVAL_HOURS = 1;
const HOURS_PER_YEAR = 24 * 365;

@Injectable()
export class HyperliquidAdapter implements VenueAdapter {
  readonly key = 'hyperliquid';
  readonly kind = 'PERP_DEX' as const;
  readonly chains: ChainKey[] = [];
  readonly capabilities: VenueCapabilities = {
    spot: false,
    perps: true,
    quote: false,
    execute: false, // signing not wired yet — data only
    balances: false,
    publicMarketData: true,
  };

  private readonly logger = new Logger(HyperliquidAdapter.name);

  async isAvailable(): Promise<boolean> {
    try {
      const r = await this.post({ type: 'meta' }, 3_000);
      return r != null;
    } catch {
      return false;
    }
  }

  /**
   * Every listed perp with live funding and OI.
   *
   * The response is a 2-tuple: `[{ universe: [...] }, [ctx, ...]]` where the
   * contexts array is INDEX-ALIGNED with `universe`. There is no id in the
   * context objects, so the pairing is purely positional — if the arrays ever
   * differ in length we bail on the extras rather than mis-attributing funding
   * rates to the wrong asset.
   */
  async perpMarkets(): Promise<PerpMarket[]> {
    const body = await this.post<any[]>({ type: 'metaAndAssetCtxs' }, 6_000);
    if (!Array.isArray(body) || body.length < 2) return [];

    const universe: any[] = body[0]?.universe ?? [];
    const ctxs: any[] = Array.isArray(body[1]) ? body[1] : [];
    const at = new Date().toISOString();

    const out: PerpMarket[] = [];
    const n = Math.min(universe.length, ctxs.length);

    for (let i = 0; i < n; i++) {
      const u = universe[i];
      const c = ctxs[i];
      if (!u?.name || !c) continue;
      // Delisted markets still appear in the universe but have no real book.
      if (u.isDelisted) continue;

      const markPrice = num(c.markPx);
      if (markPrice == null || markPrice <= 0) continue;

      const fundingRate = num(c.funding) ?? 0;
      const oi = num(c.openInterest);

      out.push({
        venue: this.key,
        base: u.name,
        symbol: u.name,
        markPrice,
        oraclePrice: num(c.oraclePx),
        indexPrice: num(c.oraclePx),
        fundingRate,
        fundingIntervalHours: FUNDING_INTERVAL_HOURS,
        fundingAprPct: toAprPct(fundingRate, FUNDING_INTERVAL_HOURS),
        // openInterest is denominated in the base asset, not USD.
        openInterestUsd: oi != null ? oi * markPrice : undefined,
        volume24hUsd: num(c.dayNtlVlm),
        maxLeverage: u.maxLeverage,
        at,
      });
    }
    return out;
  }

  private async post<T>(payload: unknown, timeoutMs: number): Promise<T | null> {
    try {
      const res = await fetch(INFO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        this.logger.warn(`Hyperliquid ${res.status}`);
        return null;
      }
      return (await res.json()) as T;
    } catch (e: any) {
      this.logger.warn(`Hyperliquid fetch failed: ${e?.message}`);
      return null;
    }
  }
}

export function num(v: unknown): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Per-interval funding rate → annualized percentage.
 * A 0.01% hourly rate compounds to ~87.6% APR simple — we report simple APR
 * (rate × intervals/year × 100) because that is the convention every perp
 * dashboard and funding-arb desk quotes.
 */
export function toAprPct(rate: number, intervalHours: number): number {
  if (!Number.isFinite(rate) || intervalHours <= 0) return 0;
  return rate * (HOURS_PER_YEAR / intervalHours) * 100;
}
