/**
 * Cross-venue perps state — the input layer for perps automation.
 *
 * Polls Hyperliquid, Binance and Bybit on an interval and aligns every market
 * by base asset so the same coin can be compared across venues. Three calls
 * per tick total (Hyperliquid 1, Bybit 1, Binance 2), all free and keyless, so
 * this is cheap enough to run continuously.
 *
 * What it produces:
 *   - `getMarkets()`      every perp on every venue, funding normalized to APR
 *   - `getSpreads()`      per-asset funding spread + mark dispersion
 *   - `getOpportunities()` spreads that clear a configurable edge threshold
 *
 * Deliberately mechanical: no LLM anywhere on this path. Funding arithmetic is
 * exact and runs every few seconds; an AI layer consumes these numbers to
 * decide *whether* to act, but must never sit in the loop that computes them.
 */

import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import type { FundingSpread, PerpMarket } from '../venue.types';
import { HyperliquidAdapter } from './hyperliquid.adapter';
import { BinancePerpsAdapter, BybitPerpsAdapter } from './cex-perps.adapter';

const POLL_INTERVAL_MS = Number(process.env.PERPS_POLL_INTERVAL_MS ?? 30_000);
/** Minimum APR spread before we call something an opportunity. */
const MIN_EDGE_APR_PCT = Number(process.env.PERPS_MIN_EDGE_APR_PCT ?? 10);
/** Assets thinner than this are excluded — the spread is untradable. */
const MIN_DEPTH_USD = Number(process.env.PERPS_MIN_DEPTH_USD ?? 1_000_000);
/**
 * How long we assume a funding-arb position is held. Used to convert an
 * annualized edge into the carry actually earned, so it can be compared
 * against the one-off cost of entering at dispersed marks.
 */
const HOLD_DAYS = Number(process.env.PERPS_HOLD_DAYS ?? 7);

@Injectable()
export class PerpsMarketService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PerpsMarketService.name);

  private markets: PerpMarket[] = [];
  private lastPollAt: number | null = null;
  /** Spreads are derived purely from `markets`, so they only change per poll. */
  private spreadCache: { at: number; value: FundingSpread[] } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(
    @Optional() private readonly hyperliquid?: HyperliquidAdapter,
    @Optional() private readonly binance?: BinancePerpsAdapter,
    @Optional() private readonly bybit?: BybitPerpsAdapter,
  ) {}

  onModuleInit() {
    if (process.env.PERPS_ENABLED === 'false') {
      this.logger.log('Perps market polling disabled (PERPS_ENABLED=false)');
      return;
    }
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  getMarkets(venue?: string): PerpMarket[] {
    return venue ? this.markets.filter((m) => m.venue === venue) : this.markets;
  }

  getMarketsFor(base: string): PerpMarket[] {
    const b = base.toUpperCase();
    return this.markets.filter((m) => m.base.toUpperCase() === b);
  }

  get lastUpdatedAt(): string | null {
    return this.lastPollAt ? new Date(this.lastPollAt).toISOString() : null;
  }

  /**
   * Funding spreads per asset, richest edge first.
   * Only assets listed on 2+ venues can have a spread, so single-venue
   * markets are excluded.
   */
  getSpreads(): FundingSpread[] {
    // Regrouping 1700 markets into 600+ spreads on every request is pure waste:
    // the inputs only change when poll() replaces the snapshot.
    if (this.spreadCache && this.spreadCache.at === (this.lastPollAt ?? 0)) {
      return this.spreadCache.value;
    }

    const byBase = new Map<string, PerpMarket[]>();
    for (const m of this.markets) {
      const b = m.base.toUpperCase();
      const list = byBase.get(b) ?? [];
      list.push(m);
      byBase.set(b, list);
    }

    const out: FundingSpread[] = [];
    for (const [base, all] of byBase) {
      // One venue can list the same asset against several quotes (Binance runs
      // both BTCUSDT and BTCUSDC perps, with different funding). Collapsing to
      // one market per venue is essential: otherwise the "spread" can be
      // between two contracts on the SAME venue, which is not a cross-venue arb.
      const markets = dedupeByVenue(all);
      if (markets.length < 2) continue;

      const sorted = [...markets].sort((a, b) => a.fundingAprPct - b.fundingAprPct);
      const cheapest = sorted[0];
      const richest = sorted[sorted.length - 1];

      out.push({
        base,
        markets,
        cheapestLong: { venue: cheapest.venue, fundingAprPct: cheapest.fundingAprPct },
        richestShort: { venue: richest.venue, fundingAprPct: richest.fundingAprPct },
        spreadAprPct: richest.fundingAprPct - cheapest.fundingAprPct,
        markDispersionPct: markDispersion(markets),
        at: new Date().toISOString(),
      });
    }

    const sorted = out.sort((a, b) => b.spreadAprPct - a.spreadAprPct);
    this.spreadCache = { at: this.lastPollAt ?? 0, value: sorted };
    return sorted;
  }

  /**
   * Spreads worth acting on.
   *
   * Two filters beyond raw edge, both of which matter in practice:
   *  - depth: an asset with no meaningful OI cannot absorb a position, so a
   *    100% APR spread there is noise, not opportunity.
   *  - mark dispersion: if marks disagree by more than the funding edge, the
   *    price risk of holding both legs exceeds the carry being harvested.
   */
  getOpportunities(minEdgeAprPct = MIN_EDGE_APR_PCT): FundingSpread[] {
    return this.getSpreads().filter((s) => {
      if (s.spreadAprPct < minEdgeAprPct) return false;

      // Both legs must be tradable. Checking only that *some* leg is deep is
      // useless: Binance never reports open interest, so a `some(oi == null)`
      // test passes unconditionally for every Binance-listed asset.
      const legs = [s.cheapestLong.venue, s.richestShort.venue];
      const bothDeep = legs.every((venue) => {
        const m = s.markets.find((x) => x.venue === venue);
        return m != null && depthUsd(m) >= MIN_DEPTH_USD;
      });
      if (!bothDeep) return false;

      // Mark dispersion is a one-off entry cost in price terms; the spread is
      // annualized carry. Comparing them directly is dimensionally wrong and
      // far too permissive, so convert the edge to the carry actually earned
      // over the assumed holding period first.
      const carryOverHoldPct = (s.spreadAprPct * HOLD_DAYS) / 365;
      return s.markDispersionPct < carryOverHoldPct;
    });
  }

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    const started = Date.now();

    try {
      const sources: Array<Promise<PerpMarket[]>> = [];
      if (this.hyperliquid) sources.push(this.hyperliquid.perpMarkets().catch(() => []));
      if (this.binance) sources.push(this.binance.perpMarkets().catch(() => []));
      if (this.bybit) sources.push(this.bybit.perpMarkets().catch(() => []));

      const results = await Promise.all(sources);
      const merged = results.flat();

      // Only replace the snapshot if we got something. A total upstream outage
      // should leave the last good state readable rather than blanking it.
      if (merged.length) {
        this.markets = merged;
        this.lastPollAt = Date.now();
      }

      const venues = new Set(merged.map((m) => m.venue));
      this.logger.log(
        `Perps poll: ${merged.length} markets across ${venues.size} venues in ${Date.now() - started}ms`,
      );
    } catch (e: any) {
      this.logger.warn(`Perps poll failed: ${e?.message}`);
    } finally {
      this.polling = false;
    }
  }
}

/**
 * Tradable depth for a market. Open interest is the better measure, but
 * Binance exposes no all-symbols OI endpoint, so 24h turnover stands in.
 * Returns 0 when neither is known — unknown depth must not pass a depth check.
 */
export function depthUsd(m: PerpMarket): number {
  return m.openInterestUsd ?? m.volume24hUsd ?? 0;
}

/**
 * Collapses a venue's multiple contracts for one asset down to the deepest,
 * so cross-venue comparisons compare venues rather than quote currencies.
 */
export function dedupeByVenue(markets: PerpMarket[]): PerpMarket[] {
  const best = new Map<string, PerpMarket>();
  for (const m of markets) {
    const prev = best.get(m.venue);
    if (!prev || depthUsd(m) > depthUsd(prev)) best.set(m.venue, m);
  }
  return [...best.values()];
}

/**
 * Max pairwise mark disagreement as a percentage of the median mark.
 * Median rather than mean so one venue printing a stale or wildly wrong mark
 * inflates the dispersion (correctly flagging the asset) instead of dragging
 * the reference price with it.
 */
export function markDispersion(markets: PerpMarket[]): number {
  const prices = markets.map((m) => m.markPrice).filter((p) => p > 0).sort((a, b) => a - b);
  if (prices.length < 2) return 0;

  const mid = Math.floor(prices.length / 2);
  const median =
    prices.length % 2 === 0 ? (prices[mid - 1] + prices[mid]) / 2 : prices[mid];
  if (median <= 0) return 0;

  return ((prices[prices.length - 1] - prices[0]) / median) * 100;
}
