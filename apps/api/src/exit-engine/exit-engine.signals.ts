/**
 * Pure exit-signal math for the ExitEngine.
 *
 * Everything here is deterministic and side-effect free so it can be unit
 * tested without a DB, RPC, or HTTP. The engine feeds it the cheap in-memory
 * data it already has (mcap ticks, liquidity, 5m price change) — no new fetches.
 */

export interface ExitSignalConfig {
  // ── volatility-adaptive trailing ──
  minTrailingPct:  number; // floor on the trailing band (lock gains in calm tape)
  maxTrailingPct:  number; // ceiling (don't give back too much in wild tape)
  volSensitivity:  number; // how many trailing-% points per 1% of realized vol
  // ── liquidity ──
  liqDrainDropPct:    number; // drop from peak liquidity that signals an LP pull / rug
  minLiqToMcapRatio:  number; // liquidity:mcap below this = dangerously thin to exit through
  // ── momentum reversal ──
  momentumDropPct5m:  number; // a 5m drop of this magnitude (while in profit) → bail
}

export const DEFAULT_EXIT_SIGNAL_CONFIG: ExitSignalConfig = {
  minTrailingPct:    parseFloat(process.env.EXIT_TRAIL_MIN_PCT     ?? '12'),
  maxTrailingPct:    parseFloat(process.env.EXIT_TRAIL_MAX_PCT     ?? '50'),
  volSensitivity:    parseFloat(process.env.EXIT_TRAIL_VOL_SENS    ?? '1.5'),
  liqDrainDropPct:   parseFloat(process.env.EXIT_LIQ_DRAIN_PCT     ?? '60'),
  minLiqToMcapRatio: parseFloat(process.env.EXIT_MIN_LIQ_MCAP      ?? '0.02'),
  momentumDropPct5m: parseFloat(process.env.EXIT_MOMENTUM_DROP_5M  ?? '25'),
};

/** Append a value to a rolling window, keeping at most `cap` most-recent entries. */
export function pushWindow(window: number[], value: number, cap: number): number[] {
  if (!Number.isFinite(value) || value <= 0) return window;
  const next = [...window, value];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/**
 * Realized volatility as a percentage: the standard deviation of consecutive
 * tick-to-tick percentage changes. Needs at least 3 points; returns 0 below
 * that (treated as "no signal yet" → engine falls back to the base band).
 */
export function realizedVolatilityPct(window: number[]): number {
  if (window.length < 3) return 0;
  const rets: number[] = [];
  for (let i = 1; i < window.length; i++) {
    const prev = window[i - 1];
    if (prev > 0) rets.push((window[i] - prev) / prev);
  }
  if (rets.length < 2) return 0;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / rets.length;
  return Math.sqrt(variance) * 100;
}

/**
 * Volatility-adaptive trailing band. Starts from the tier's base trailing %,
 * widens with realized volatility (so normal meme noise doesn't stop you out),
 * and is clamped to [min, max]. This is the cheap stand-in for ATR-based
 * trailing when no OHLC feed is available.
 */
export function adaptiveTrailingPct(baseTrailingPct: number, volPct: number, cfg: ExitSignalConfig): number {
  const widened = baseTrailingPct + volPct * cfg.volSensitivity;
  return Math.min(cfg.maxTrailingPct, Math.max(cfg.minTrailingPct, widened));
}

/** True when current liquidity has collapsed from its observed peak — LP-pull / rug proxy. */
export function liquidityDrainTriggered(currentLiqUsd: number, peakLiqUsd: number, cfg: ExitSignalConfig): boolean {
  if (!(peakLiqUsd > 0) || !(currentLiqUsd >= 0)) return false;
  return currentLiqUsd < peakLiqUsd * (1 - cfg.liqDrainDropPct / 100);
}

/** True when liquidity is too thin relative to market cap to exit cleanly. */
export function thinLiquidity(liqUsd: number, mcapUsd: number, cfg: ExitSignalConfig): boolean {
  if (!(mcapUsd > 0) || !(liqUsd >= 0)) return false;
  return liqUsd / mcapUsd < cfg.minLiqToMcapRatio;
}

/**
 * "First red candle" proxy: while in profit, a sharp 5-minute drop is treated
 * as a reversal worth exiting on rather than waiting for the full trailing band.
 */
export function momentumReversal(priceChange5mPct: number | undefined, inProfit: boolean, cfg: ExitSignalConfig): boolean {
  if (!inProfit || priceChange5mPct == null || !Number.isFinite(priceChange5mPct)) return false;
  return priceChange5mPct <= -cfg.momentumDropPct5m;
}
