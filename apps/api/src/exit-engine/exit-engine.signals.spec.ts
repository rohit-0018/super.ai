import {
  pushWindow,
  realizedVolatilityPct,
  adaptiveTrailingPct,
  liquidityDrainTriggered,
  thinLiquidity,
  momentumReversal,
  DEFAULT_EXIT_SIGNAL_CONFIG,
  ExitSignalConfig,
} from './exit-engine.signals';

const cfg: ExitSignalConfig = {
  minTrailingPct: 12,
  maxTrailingPct: 50,
  volSensitivity: 1.5,
  liqDrainDropPct: 60,
  minLiqToMcapRatio: 0.02,
  momentumDropPct5m: 25,
};

describe('pushWindow', () => {
  it('caps length to the most recent N', () => {
    let w: number[] = [];
    for (let i = 1; i <= 10; i++) w = pushWindow(w, i, 5);
    expect(w).toEqual([6, 7, 8, 9, 10]);
  });
  it('ignores non-positive / non-finite values', () => {
    expect(pushWindow([1, 2], 0, 5)).toEqual([1, 2]);
    expect(pushWindow([1, 2], NaN, 5)).toEqual([1, 2]);
  });
});

describe('realizedVolatilityPct', () => {
  it('returns 0 below 3 points', () => {
    expect(realizedVolatilityPct([])).toBe(0);
    expect(realizedVolatilityPct([100, 110])).toBe(0);
  });
  it('is 0 for a flat series', () => {
    expect(realizedVolatilityPct([100, 100, 100, 100])).toBeCloseTo(0);
  });
  it('is larger for a choppier series', () => {
    const calm   = realizedVolatilityPct([100, 101, 102, 103, 104]);
    const choppy = realizedVolatilityPct([100, 130, 90, 140, 80]);
    expect(choppy).toBeGreaterThan(calm);
  });
});

describe('adaptiveTrailingPct', () => {
  it('widens the band as volatility rises', () => {
    const calm = adaptiveTrailingPct(20, 2, cfg);
    const wild = adaptiveTrailingPct(20, 15, cfg);
    expect(wild).toBeGreaterThan(calm);
  });
  it('clamps to [min, max]', () => {
    expect(adaptiveTrailingPct(5, 0, cfg)).toBe(12);    // floored
    expect(adaptiveTrailingPct(40, 100, cfg)).toBe(50); // capped
  });
});

describe('liquidityDrainTriggered', () => {
  it('fires when liquidity collapses past the drop threshold', () => {
    expect(liquidityDrainTriggered(30_000, 100_000, cfg)).toBe(true);  // -70%
    expect(liquidityDrainTriggered(50_000, 100_000, cfg)).toBe(false); // -50%, under 60%
  });
  it('is safe with no peak', () => {
    expect(liquidityDrainTriggered(0, 0, cfg)).toBe(false);
  });
});

describe('thinLiquidity', () => {
  it('flags liquidity that is too thin vs mcap', () => {
    expect(thinLiquidity(10_000, 1_000_000, cfg)).toBe(true);  // 1% < 2%
    expect(thinLiquidity(50_000, 1_000_000, cfg)).toBe(false); // 5% > 2%
  });
});

describe('momentumReversal', () => {
  it('fires only when in profit and the 5m drop is sharp', () => {
    expect(momentumReversal(-30, true, cfg)).toBe(true);
    expect(momentumReversal(-30, false, cfg)).toBe(false); // not in profit → ignore
    expect(momentumReversal(-10, true, cfg)).toBe(false);  // mild dip
    expect(momentumReversal(undefined, true, cfg)).toBe(false);
  });
});

describe('DEFAULT_EXIT_SIGNAL_CONFIG', () => {
  it('has sane defaults', () => {
    expect(DEFAULT_EXIT_SIGNAL_CONFIG.minTrailingPct).toBeLessThan(DEFAULT_EXIT_SIGNAL_CONFIG.maxTrailingPct);
    expect(DEFAULT_EXIT_SIGNAL_CONFIG.liqDrainDropPct).toBeGreaterThan(0);
  });
});
