// Types from sibling modules are used by consuming code; keep imports minimal.

// ─── ExecutedTrade ─────────────────────────────────────────────────────────

export interface ExecutedTrade {
  readonly tradeId: string;
  readonly userId: string;
  readonly strategyId: string;
  readonly instrument: string;
  readonly side: 'BUY' | 'SELL';
  readonly quantity: number;
  readonly price: number;
  readonly notional: number;
  readonly timestamp: string;
  readonly orderId: string;
  readonly settlementDate: string;
}

// ─── DriftCheckResult ──────────────────────────────────────────────────────

export interface DriftCheckResult {
  readonly driftDetected: boolean;
  readonly driftScore: number;
  readonly driftReasons: string[];
}

// ─── TradeProfile ──────────────────────────────────────────────────────────

export interface TradeProfile {
  readonly instrumentDistribution: Record<string, number>;
  readonly totalTrades: number;
  readonly averageOrderSize: number;
  readonly averageHoldTimeMinutes: number;
}

// ─── Logger Interface ──────────────────────────────────────────────────────

export interface DriftDetectorLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

// ─── Redis Adapter Interface ───────────────────────────────────────────────

export interface RedisAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
}

// ─── Config for Drift Detection ────────────────────────────────────────────

export interface DriftDetectorConfig {
  readonly driftThreshold: number;
  readonly profileTtlSeconds: number;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function chiSquaredDistance(
  baseline: Record<string, number>,
  current: Record<string, number>,
): number {
  const allKeys = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  let chiSq = 0;

  for (const key of allKeys) {
    const baseVal = baseline[key] ?? 0;
    const currVal = current[key] ?? 0;
    const denominator = baseVal + currVal;
    if (denominator > 0) {
      chiSq += ((baseVal - currVal) ** 2) / denominator;
    }
  }

  return chiSq;
}

function normalizeDistribution(dist: Record<string, number>): Record<string, number> {
  const total = Object.values(dist).reduce((sum, v) => sum + v, 0);
  if (total === 0) return dist;
  const normalized: Record<string, number> = {};
  for (const [key, val] of Object.entries(dist)) {
    normalized[key] = val / total;
  }
  return normalized;
}

function computeProfile(trades: readonly ExecutedTrade[]): TradeProfile {
  if (trades.length === 0) {
    return {
      instrumentDistribution: {},
      totalTrades: 0,
      averageOrderSize: 0,
      averageHoldTimeMinutes: 0,
    };
  }

  const instrumentCounts: Record<string, number> = {};
  let totalSize = 0;

  for (const trade of trades) {
    instrumentCounts[trade.instrument] = (instrumentCounts[trade.instrument] ?? 0) + 1;
    totalSize += trade.quantity * trade.price;
  }

  const avgSize = totalSize / trades.length;

  // Estimate hold time from consecutive trades on same instrument
  const sortedTrades = [...trades].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  let holdTimeSum = 0;
  let holdTimeCount = 0;
  const lastTradeByInstrument = new Map<string, ExecutedTrade>();

  for (const trade of sortedTrades) {
    const prev = lastTradeByInstrument.get(trade.instrument);
    if (prev !== undefined) {
      const diffMs = new Date(trade.timestamp).getTime() - new Date(prev.timestamp).getTime();
      holdTimeSum += diffMs / 60_000;
      holdTimeCount++;
    }
    lastTradeByInstrument.set(trade.instrument, trade);
  }

  const avgHoldTime = holdTimeCount > 0 ? holdTimeSum / holdTimeCount : 0;

  return {
    instrumentDistribution: instrumentCounts,
    totalTrades: trades.length,
    averageOrderSize: avgSize,
    averageHoldTimeMinutes: avgHoldTime,
  };
}

// ─── StrategyDriftDetector ─────────────────────────────────────────────────

const REDIS_KEY_PREFIX = 'security:drift:profile:';
const PROFILE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days default

export class StrategyDriftDetector {
  private readonly config: DriftDetectorConfig;
  private readonly logger: DriftDetectorLogger;
  private readonly redis: RedisAdapter;

  constructor(
    config: DriftDetectorConfig,
    logger: DriftDetectorLogger,
    redis: RedisAdapter,
  ) {
    this.config = config;
    this.logger = logger;
    this.redis = redis;
  }

  async recordTrade(trade: ExecutedTrade): Promise<void> {
    const key = `${REDIS_KEY_PREFIX}${trade.strategyId}:trades`;
    const existing = await this.redis.get(key);
    const trades: ExecutedTrade[] = existing !== null ? (JSON.parse(existing) as ExecutedTrade[]) : [];

    trades.push(trade);

    // Keep only trades within the last 30 days
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const filtered = trades.filter(
      (t) => new Date(t.timestamp).getTime() >= thirtyDaysAgo,
    );

    const ttl = this.config.profileTtlSeconds > 0 ? this.config.profileTtlSeconds : PROFILE_TTL_SECONDS;
    await this.redis.set(key, JSON.stringify(filtered), ttl);

    // Update computed profile
    const profile = computeProfile(filtered);
    const profileKey = `${REDIS_KEY_PREFIX}${trade.strategyId}:profile`;
    await this.redis.set(profileKey, JSON.stringify(profile), ttl);

    this.logger.info('Trade recorded for drift tracking', {
      strategyId: trade.strategyId,
      tradeId: trade.tradeId,
      totalTrackedTrades: filtered.length,
    });
  }

  async check(strategyId: string, recentTrades: readonly ExecutedTrade[]): Promise<DriftCheckResult> {
    const profileKey = `${REDIS_KEY_PREFIX}${strategyId}:profile`;
    const raw = await this.redis.get(profileKey);

    if (raw === null) {
      this.logger.info('No baseline profile found, no drift detection possible', { strategyId });
      return { driftDetected: false, driftScore: 0, driftReasons: [] };
    }

    const baseline = JSON.parse(raw) as TradeProfile;
    const current = computeProfile(recentTrades);

    if (baseline.totalTrades === 0) {
      return { driftDetected: false, driftScore: 0, driftReasons: [] };
    }

    const driftReasons: string[] = [];

    // 1. Chi-squared distance on instrument distribution
    const baselineNorm = normalizeDistribution(baseline.instrumentDistribution);
    const currentNorm = normalizeDistribution(current.instrumentDistribution);
    const chiSq = chiSquaredDistance(baselineNorm, currentNorm);
    const instrumentDriftScore = Math.min(chiSq / 2, 1); // Normalize to 0-1

    if (instrumentDriftScore > 0.3) {
      driftReasons.push(
        `Instrument distribution drift: chi-squared distance ${chiSq.toFixed(4)}`,
      );
    }

    // 2. Average order size deviation
    let orderSizeDriftScore = 0;
    if (baseline.averageOrderSize > 0 && current.averageOrderSize > 0) {
      const deviation = Math.abs(current.averageOrderSize - baseline.averageOrderSize) / baseline.averageOrderSize;
      orderSizeDriftScore = Math.min(deviation, 1);
      if (deviation > 0.5) {
        driftReasons.push(
          `Order size deviation: ${(deviation * 100).toFixed(1)}% from baseline`,
        );
      }
    }

    // 3. Average hold time deviation
    let holdTimeDriftScore = 0;
    if (baseline.averageHoldTimeMinutes > 0 && current.averageHoldTimeMinutes > 0) {
      const deviation = Math.abs(current.averageHoldTimeMinutes - baseline.averageHoldTimeMinutes) / baseline.averageHoldTimeMinutes;
      holdTimeDriftScore = Math.min(deviation, 1);
      if (deviation > 0.5) {
        driftReasons.push(
          `Hold time deviation: ${(deviation * 100).toFixed(1)}% from baseline`,
        );
      }
    }

    // Composite score: weighted average
    const compositeScore = (instrumentDriftScore * 0.4 + orderSizeDriftScore * 0.35 + holdTimeDriftScore * 0.25);
    const clampedScore = Math.min(Math.max(compositeScore, 0), 1);
    const driftDetected = clampedScore >= this.config.driftThreshold;

    if (driftDetected) {
      this.logger.warn('Strategy drift detected', {
        strategyId,
        driftScore: clampedScore,
        driftReasons,
      });
    }

    return {
      driftDetected,
      driftScore: clampedScore,
      driftReasons,
    };
  }
}

export { computeProfile, chiSquaredDistance, normalizeDistribution };
