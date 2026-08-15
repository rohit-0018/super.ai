/**
 * Binance USD-M Futures and Bybit linear perps — public market data only.
 *
 * Both are free and unauthenticated for market data (verified live against
 * fapi.binance.com/fapi/v1/premiumIndex and api.bybit.com/v5/market/tickers).
 * No API key is needed here; the keys stored in CexConnection are only required
 * for balances and order placement, which this adapter deliberately does not do.
 *
 * Call efficiency matters because these run on a loop:
 *   Bybit   — ONE call returns every linear perp with funding, OI, and mark.
 *   Binance — premiumIndex (all symbols) + ticker/24hr (all symbols) = 2 calls.
 *             Binance has no all-symbols open-interest endpoint, so OI is left
 *             undefined rather than fanning out one call per symbol.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { PerpMarket, VenueAdapter, VenueCapabilities } from '../venue.types';
import type { ChainKey } from '../chain-registry';
import { num, toAprPct } from './hyperliquid.adapter';

/** Binance and Bybit both settle perp funding every 8 hours. */
const FUNDING_INTERVAL_HOURS = 8;

const CAPS: VenueCapabilities = {
  spot: false,
  perps: true,
  quote: false,
  execute: false,
  balances: false,
  publicMarketData: true,
};

/** `BTCUSDT` → `BTC`, so the same asset lines up across venues. */
export function baseFromUsdtSymbol(symbol: string): string | null {
  if (!symbol) return null;
  if (symbol.endsWith('USDT')) return symbol.slice(0, -4);
  if (symbol.endsWith('USDC')) return symbol.slice(0, -4);
  return null;
}

@Injectable()
export class BinancePerpsAdapter implements VenueAdapter {
  readonly key = 'binance';
  readonly kind = 'CEX' as const;
  readonly chains: ChainKey[] = [];
  readonly capabilities = CAPS;

  private readonly logger = new Logger(BinancePerpsAdapter.name);
  private readonly base = 'https://fapi.binance.com/fapi/v1';

  async isAvailable(): Promise<boolean> {
    try {
      const r = await fetch(`${this.base}/ping`, { signal: AbortSignal.timeout(3_000) });
      return r.ok;
    } catch {
      return false;
    }
  }

  async perpMarkets(): Promise<PerpMarket[]> {
    const [premium, tickers] = await Promise.all([
      this.get<any[]>(`${this.base}/premiumIndex`),
      this.get<any[]>(`${this.base}/ticker/24hr`),
    ]);
    if (!Array.isArray(premium)) return [];

    const volBySymbol = new Map<string, number>();
    for (const t of tickers ?? []) {
      const v = num(t?.quoteVolume);
      if (t?.symbol && v != null) volBySymbol.set(t.symbol, v);
    }

    const at = new Date().toISOString();
    const out: PerpMarket[] = [];

    for (const p of premium) {
      const base = baseFromUsdtSymbol(p?.symbol);
      if (!base) continue; // skip coin-margined and non-USDT quotes
      const markPrice = num(p.markPrice);
      if (markPrice == null || markPrice <= 0) continue;

      const fundingRate = num(p.lastFundingRate) ?? 0;

      out.push({
        venue: this.key,
        base,
        symbol: p.symbol,
        markPrice,
        indexPrice: num(p.indexPrice),
        fundingRate,
        fundingIntervalHours: FUNDING_INTERVAL_HOURS,
        fundingAprPct: toAprPct(fundingRate, FUNDING_INTERVAL_HOURS),
        nextFundingAt: p.nextFundingTime
          ? new Date(Number(p.nextFundingTime)).toISOString()
          : undefined,
        volume24hUsd: volBySymbol.get(p.symbol),
        at,
      });
    }
    return out;
  }

  private async get<T>(url: string): Promise<T | null> {
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(6_000),
      });
      if (!res.ok) {
        this.logger.warn(`Binance futures ${res.status} for ${url}`);
        return null;
      }
      return (await res.json()) as T;
    } catch (e: any) {
      this.logger.warn(`Binance futures fetch failed: ${e?.message}`);
      return null;
    }
  }
}

@Injectable()
export class BybitPerpsAdapter implements VenueAdapter {
  readonly key = 'bybit';
  readonly kind = 'CEX' as const;
  readonly chains: ChainKey[] = [];
  readonly capabilities = CAPS;

  private readonly logger = new Logger(BybitPerpsAdapter.name);
  private readonly url = 'https://api.bybit.com/v5/market/tickers?category=linear';

  async isAvailable(): Promise<boolean> {
    try {
      const r = await fetch(this.url, { signal: AbortSignal.timeout(3_000) });
      return r.ok;
    } catch {
      return false;
    }
  }

  /** One call covers the whole linear book, including OI in USD. */
  async perpMarkets(): Promise<PerpMarket[]> {
    let body: any;
    try {
      const res = await fetch(this.url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(6_000),
      });
      if (!res.ok) {
        this.logger.warn(`Bybit ${res.status}`);
        return [];
      }
      body = await res.json();
    } catch (e: any) {
      this.logger.warn(`Bybit fetch failed: ${e?.message}`);
      return [];
    }

    if (body?.retCode !== 0) return [];
    const at = new Date().toISOString();
    const out: PerpMarket[] = [];

    for (const t of body?.result?.list ?? []) {
      const base = baseFromUsdtSymbol(t?.symbol);
      if (!base) continue;
      const markPrice = num(t.markPrice);
      if (markPrice == null || markPrice <= 0) continue;

      const fundingRate = num(t.fundingRate) ?? 0;

      out.push({
        venue: this.key,
        base,
        symbol: t.symbol,
        markPrice,
        indexPrice: num(t.indexPrice),
        fundingRate,
        fundingIntervalHours: FUNDING_INTERVAL_HOURS,
        fundingAprPct: toAprPct(fundingRate, FUNDING_INTERVAL_HOURS),
        nextFundingAt: t.nextFundingTime
          ? new Date(Number(t.nextFundingTime)).toISOString()
          : undefined,
        openInterestUsd: num(t.openInterestValue),
        volume24hUsd: num(t.turnover24h),
        at,
      });
    }
    return out;
  }
}
