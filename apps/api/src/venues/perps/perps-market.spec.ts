import { toAprPct } from './hyperliquid.adapter';
import { baseFromUsdtSymbol } from './cex-perps.adapter';
import { dedupeByVenue, depthUsd, markDispersion, PerpsMarketService } from './perps-market.service';
import type { PerpMarket } from '../venue.types';

const mkt = (over: Partial<PerpMarket>): PerpMarket => ({
  venue: 'hyperliquid',
  base: 'BTC',
  symbol: 'BTC',
  markPrice: 60_000,
  fundingRate: 0,
  fundingIntervalHours: 1,
  fundingAprPct: 0,
  at: '2026-08-03T00:00:00.000Z',
  ...over,
});

describe('toAprPct', () => {
  /**
   * The core normalization. Hyperliquid funds hourly, Binance/Bybit every 8h,
   * so identical raw rates represent very different carry. Comparing the raw
   * `funding` field across venues — the obvious thing to do — is off by 8x.
   */
  it('annualizes an hourly rate', () => {
    expect(toAprPct(0.0001, 1)).toBeCloseTo(87.6, 5);
  });

  it('annualizes an 8-hour rate', () => {
    expect(toAprPct(0.0001, 8)).toBeCloseTo(10.95, 5);
  });

  it('makes the interval difference explicit', () => {
    expect(toAprPct(0.0001, 1) / toAprPct(0.0001, 8)).toBeCloseTo(8, 6);
  });

  it('preserves sign for negative funding (shorts pay longs)', () => {
    expect(toAprPct(-0.0001, 8)).toBeCloseTo(-10.95, 5);
  });

  it('is zero-safe and guards against a bad interval', () => {
    expect(toAprPct(0, 8)).toBe(0);
    expect(toAprPct(0.01, 0)).toBe(0);
    expect(toAprPct(NaN, 8)).toBe(0);
  });
});

describe('baseFromUsdtSymbol', () => {
  it('strips the quote so venues align on the same asset', () => {
    expect(baseFromUsdtSymbol('BTCUSDT')).toBe('BTC');
    expect(baseFromUsdtSymbol('1000PEPEUSDT')).toBe('1000PEPE');
    expect(baseFromUsdtSymbol('ETHUSDC')).toBe('ETH');
  });

  it('rejects quotes we do not handle rather than mangling the symbol', () => {
    expect(baseFromUsdtSymbol('BTCBUSD')).toBeNull();
    expect(baseFromUsdtSymbol('ETHBTC')).toBeNull();
    expect(baseFromUsdtSymbol('')).toBeNull();
  });
});

describe('markDispersion', () => {
  it('is zero when venues agree', () => {
    expect(markDispersion([mkt({}), mkt({ venue: 'binance' })])).toBe(0);
  });

  it('measures spread as a percentage of the median', () => {
    const d = markDispersion([
      mkt({ markPrice: 100 }),
      mkt({ venue: 'binance', markPrice: 101 }),
    ]);
    // (101 - 100) / 100.5 * 100
    expect(d).toBeCloseTo(0.995, 2);
  });

  it('uses the median so one bad print inflates dispersion rather than skewing the reference', () => {
    const d = markDispersion([
      mkt({ markPrice: 100 }),
      mkt({ venue: 'binance', markPrice: 100 }),
      mkt({ venue: 'bybit', markPrice: 500 }), // stale/garbage print
    ]);
    // Median stays 100, so the outlier shows up as a large dispersion.
    expect(d).toBeCloseTo(400, 5);
  });

  it('returns 0 for fewer than two usable prices', () => {
    expect(markDispersion([])).toBe(0);
    expect(markDispersion([mkt({})])).toBe(0);
    expect(markDispersion([mkt({ markPrice: 0 }), mkt({ markPrice: 0 })])).toBe(0);
  });
});

describe('depthUsd', () => {
  it('prefers open interest', () => {
    expect(depthUsd(mkt({ openInterestUsd: 5e6, volume24hUsd: 1e6 }))).toBe(5e6);
  });

  it('falls back to 24h volume when OI is unavailable (Binance case)', () => {
    expect(depthUsd(mkt({ openInterestUsd: undefined, volume24hUsd: 3e6 }))).toBe(3e6);
  });

  it('treats fully unknown depth as zero so it cannot pass a depth check', () => {
    expect(depthUsd(mkt({ openInterestUsd: undefined, volume24hUsd: undefined }))).toBe(0);
  });
});

describe('dedupeByVenue', () => {
  /**
   * Regression: Binance lists both BTCUSDT and BTCUSDC perps with different
   * funding rates. Without dedupe, BTC showed up twice under `binance` and the
   * "cross-venue spread" could be between two Binance contracts.
   */
  it('collapses one venue&apos;s multiple quote contracts to the deepest', () => {
    const out = dedupeByVenue([
      mkt({ venue: 'binance', symbol: 'BTCUSDT', fundingAprPct: 10.95, volume24hUsd: 9e9 }),
      mkt({ venue: 'binance', symbol: 'BTCUSDC', fundingAprPct: 7.32, volume24hUsd: 1e8 }),
      mkt({ venue: 'bybit', symbol: 'BTCUSDT', fundingAprPct: 9.45, volume24hUsd: 5e9 }),
    ]);

    expect(out).toHaveLength(2);
    expect(out.filter((m) => m.venue === 'binance')).toHaveLength(1);
    expect(out.find((m) => m.venue === 'binance')!.symbol).toBe('BTCUSDT');
  });

  it('leaves single-contract venues untouched', () => {
    const input = [mkt({ venue: 'hyperliquid' }), mkt({ venue: 'bybit' })];
    expect(dedupeByVenue(input)).toHaveLength(2);
  });
});

describe('PerpsMarketService spreads', () => {
  const load = (markets: PerpMarket[]) => {
    const svc = new PerpsMarketService();
    (svc as any).markets = markets;
    return svc;
  };

  it('identifies the cheapest long and richest short venue', () => {
    const svc = load([
      mkt({ venue: 'hyperliquid', base: 'SOL', fundingAprPct: -20, openInterestUsd: 5e6 }),
      mkt({ venue: 'binance', base: 'SOL', fundingAprPct: 30, openInterestUsd: 5e6 }),
      mkt({ venue: 'bybit', base: 'SOL', fundingAprPct: 5, openInterestUsd: 5e6 }),
    ]);

    const [s] = svc.getSpreads();
    expect(s.base).toBe('SOL');
    expect(s.cheapestLong.venue).toBe('hyperliquid');
    expect(s.richestShort.venue).toBe('binance');
    expect(s.spreadAprPct).toBe(50);
  });

  it('excludes assets listed on only one venue — no spread is possible', () => {
    const svc = load([mkt({ base: 'WIF', fundingAprPct: 100 })]);
    expect(svc.getSpreads()).toEqual([]);
  });

  it('sorts spreads widest-edge first', () => {
    const svc = load([
      mkt({ base: 'A', venue: 'hyperliquid', fundingAprPct: 0 }),
      mkt({ base: 'A', venue: 'binance', fundingAprPct: 10 }),
      mkt({ base: 'B', venue: 'hyperliquid', fundingAprPct: 0 }),
      mkt({ base: 'B', venue: 'binance', fundingAprPct: 90 }),
    ]);
    expect(svc.getSpreads().map((s) => s.base)).toEqual(['B', 'A']);
  });

  it('filters opportunities below the edge threshold', () => {
    const svc = load([
      mkt({ base: 'SOL', venue: 'hyperliquid', fundingAprPct: 0, openInterestUsd: 5e6 }),
      mkt({ base: 'SOL', venue: 'binance', fundingAprPct: 5, openInterestUsd: 5e6 }),
    ]);
    expect(svc.getOpportunities(10)).toEqual([]);
    expect(svc.getOpportunities(1)).toHaveLength(1);
  });

  it('rejects an edge that mark dispersion swamps', () => {
    // 20 APR points of carry, but marks disagree by ~50% — the price risk of
    // holding both legs dwarfs the funding being harvested.
    const svc = load([
      mkt({ base: 'X', venue: 'hyperliquid', fundingAprPct: 0, markPrice: 100, openInterestUsd: 5e6 }),
      mkt({ base: 'X', venue: 'binance', fundingAprPct: 20, markPrice: 160, openInterestUsd: 5e6 }),
    ]);
    expect(svc.getOpportunities(10)).toEqual([]);
  });

  it('requires BOTH legs to be deep, not just one', () => {
    // Regression: the old filter was `.some(m => m.openInterestUsd == null || ...)`.
    // Binance never reports OI, so any Binance-listed asset passed the depth
    // check unconditionally — which is how 217 "opportunities" appeared.
    const svc = load([
      mkt({ base: 'Y', venue: 'hyperliquid', fundingAprPct: 0, openInterestUsd: 5e6 }),
      mkt({
        base: 'Y',
        venue: 'binance',
        fundingAprPct: 60,
        openInterestUsd: undefined,
        volume24hUsd: undefined,
      }),
    ]);
    expect(svc.getOpportunities(10)).toEqual([]);
  });

  it('accepts a deep Binance leg via 24h volume when OI is unavailable', () => {
    const svc = load([
      mkt({ base: 'Z', venue: 'hyperliquid', fundingAprPct: 0, openInterestUsd: 5e6 }),
      mkt({
        base: 'Z',
        venue: 'binance',
        fundingAprPct: 60,
        openInterestUsd: undefined,
        volume24hUsd: 8e8,
      }),
    ]);
    expect(svc.getOpportunities(10)).toHaveLength(1);
  });

  it('compares dispersion against carry actually earned, not raw APR', () => {
    // 20% APR edge with 5% mark dispersion. The old guard compared 5 < 20 and
    // let this through, but over a 7-day hold the carry is only ~0.38% — far
    // less than the 5% cost of entering at dispersed marks.
    const svc = load([
      mkt({ base: 'W', venue: 'hyperliquid', fundingAprPct: 0, markPrice: 100, openInterestUsd: 5e6 }),
      mkt({ base: 'W', venue: 'binance', fundingAprPct: 20, markPrice: 105, openInterestUsd: 5e6 }),
    ]);
    expect(svc.getSpreads()[0].spreadAprPct).toBe(20);
    expect(svc.getOpportunities(10)).toEqual([]);
  });

  it('does not report a spread between two contracts on the same venue', () => {
    // BTCUSDT vs BTCUSDC on Binance is not a cross-venue arb.
    const svc = load([
      mkt({ base: 'BTC', venue: 'binance', symbol: 'BTCUSDT', fundingAprPct: 10.95, volume24hUsd: 9e9 }),
      mkt({ base: 'BTC', venue: 'binance', symbol: 'BTCUSDC', fundingAprPct: 7.32, volume24hUsd: 1e8 }),
    ]);
    expect(svc.getSpreads()).toEqual([]);
  });

  it('rejects illiquid assets regardless of headline edge', () => {
    const svc = load([
      mkt({ base: 'THIN', venue: 'hyperliquid', fundingAprPct: 0, openInterestUsd: 1_000 }),
      mkt({ base: 'THIN', venue: 'binance', fundingAprPct: 500, openInterestUsd: 2_000 }),
    ]);
    expect(svc.getOpportunities(10)).toEqual([]);
  });

  it('is case-insensitive when looking up an asset', () => {
    const svc = load([mkt({ base: 'BTC' })]);
    expect(svc.getMarketsFor('btc')).toHaveLength(1);
    expect(svc.getMarketsFor('BTC')).toHaveLength(1);
  });
});
