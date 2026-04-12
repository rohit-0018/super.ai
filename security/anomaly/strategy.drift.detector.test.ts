import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  StrategyDriftDetector,
  computeProfile,
  chiSquaredDistance,
  normalizeDistribution,
  type ExecutedTrade,
  type DriftDetectorLogger,
  type RedisAdapter,
  type DriftDetectorConfig,
} from './strategy.drift.detector.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeLogger(): DriftDetectorLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeRedis(): RedisAdapter & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn<RedisAdapter['get']>(async (key: string) => store.get(key) ?? null),
    set: vi.fn<RedisAdapter['set']>(async (key: string, value: string) => {
      store.set(key, value);
    }),
  };
}

function makeConfig(overrides: Partial<DriftDetectorConfig> = {}): DriftDetectorConfig {
  return {
    driftThreshold: 0.3,
    profileTtlSeconds: 2592000,
    ...overrides,
  };
}

function makeTrade(overrides: Partial<ExecutedTrade> = {}): ExecutedTrade {
  return {
    tradeId: 'trade-1',
    userId: 'user-1',
    strategyId: 'strat-1',
    instrument: 'BTC-USDT',
    side: 'BUY',
    quantity: 1,
    price: 50000,
    notional: 50000,
    timestamp: '2026-04-12T10:00:00.000Z',
    orderId: 'order-1',
    settlementDate: '2026-04-12',
    ...overrides,
  };
}

// ─── Unit Tests: Helper Functions ──────────────────────────────────────────

describe('normalizeDistribution', () => {
  it('normalizes counts to proportions', () => {
    const result = normalizeDistribution({ BTC: 3, ETH: 1 });
    expect(result['BTC']).toBeCloseTo(0.75);
    expect(result['ETH']).toBeCloseTo(0.25);
  });

  it('handles empty distribution', () => {
    const result = normalizeDistribution({});
    expect(result).toEqual({});
  });
});

describe('chiSquaredDistance', () => {
  it('returns 0 for identical distributions', () => {
    const dist = { BTC: 0.5, ETH: 0.5 };
    expect(chiSquaredDistance(dist, dist)).toBe(0);
  });

  it('returns positive value for different distributions', () => {
    const baseline = { BTC: 0.8, ETH: 0.2 };
    const current = { BTC: 0.2, ETH: 0.8 };
    const distance = chiSquaredDistance(baseline, current);
    expect(distance).toBeGreaterThan(0);
  });

  it('handles keys present only in one distribution', () => {
    const baseline = { BTC: 0.5, ETH: 0.5 };
    const current = { BTC: 0.5, SOL: 0.5 };
    const distance = chiSquaredDistance(baseline, current);
    expect(distance).toBeGreaterThan(0);
  });
});

describe('computeProfile', () => {
  it('returns zero profile for empty trades', () => {
    const profile = computeProfile([]);
    expect(profile.totalTrades).toBe(0);
    expect(profile.averageOrderSize).toBe(0);
    expect(profile.averageHoldTimeMinutes).toBe(0);
    expect(profile.instrumentDistribution).toEqual({});
  });

  it('computes correct instrument distribution', () => {
    const trades = [
      makeTrade({ instrument: 'BTC-USDT' }),
      makeTrade({ instrument: 'BTC-USDT' }),
      makeTrade({ instrument: 'ETH-USDT' }),
    ];
    const profile = computeProfile(trades);
    expect(profile.instrumentDistribution).toEqual({ 'BTC-USDT': 2, 'ETH-USDT': 1 });
    expect(profile.totalTrades).toBe(3);
  });

  it('computes average order size', () => {
    const trades = [
      makeTrade({ quantity: 2, price: 100 }),
      makeTrade({ quantity: 4, price: 100 }),
    ];
    const profile = computeProfile(trades);
    expect(profile.averageOrderSize).toBe(300); // (200 + 400) / 2
  });

  it('computes average hold time from consecutive trades', () => {
    const trades = [
      makeTrade({ instrument: 'BTC-USDT', timestamp: '2026-04-12T10:00:00.000Z' }),
      makeTrade({ instrument: 'BTC-USDT', timestamp: '2026-04-12T10:30:00.000Z' }),
      makeTrade({ instrument: 'BTC-USDT', timestamp: '2026-04-12T11:30:00.000Z' }),
    ];
    const profile = computeProfile(trades);
    // First gap: 30min, second gap: 60min => avg = 45min
    expect(profile.averageHoldTimeMinutes).toBeCloseTo(45);
  });
});

// ─── StrategyDriftDetector Tests ───────────────────────────────────────────

describe('StrategyDriftDetector', () => {
  let logger: DriftDetectorLogger;
  let redis: ReturnType<typeof makeRedis>;
  let config: DriftDetectorConfig;
  let detector: StrategyDriftDetector;

  beforeEach(() => {
    logger = makeLogger();
    redis = makeRedis();
    config = makeConfig();
    detector = new StrategyDriftDetector(config, logger, redis);
  });

  describe('recordTrade', () => {
    it('stores trade in Redis', async () => {
      const trade = makeTrade();
      await detector.recordTrade(trade);

      expect(redis.set).toHaveBeenCalled();
      const tradesKey = 'security:drift:profile:strat-1:trades';
      const stored = redis.store.get(tradesKey);
      expect(stored).toBeDefined();
      const parsed = JSON.parse(stored!) as ExecutedTrade[];
      expect(parsed).toHaveLength(1);
      expect(parsed[0]?.tradeId).toBe('trade-1');
    });

    it('appends to existing trades', async () => {
      await detector.recordTrade(makeTrade({ tradeId: 'trade-1' }));
      await detector.recordTrade(makeTrade({ tradeId: 'trade-2' }));

      const tradesKey = 'security:drift:profile:strat-1:trades';
      const stored = redis.store.get(tradesKey);
      const parsed = JSON.parse(stored!) as ExecutedTrade[];
      expect(parsed).toHaveLength(2);
    });

    it('filters out trades older than 30 days', async () => {
      const oldTimestamp = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      await detector.recordTrade(makeTrade({ tradeId: 'old', timestamp: oldTimestamp }));
      await detector.recordTrade(makeTrade({ tradeId: 'new', timestamp: new Date().toISOString() }));

      const tradesKey = 'security:drift:profile:strat-1:trades';
      const stored = redis.store.get(tradesKey);
      const parsed = JSON.parse(stored!) as ExecutedTrade[];
      expect(parsed).toHaveLength(1);
      expect(parsed[0]?.tradeId).toBe('new');
    });

    it('updates computed profile in Redis', async () => {
      await detector.recordTrade(makeTrade({ instrument: 'BTC-USDT' }));

      const profileKey = 'security:drift:profile:strat-1:profile';
      const stored = redis.store.get(profileKey);
      expect(stored).toBeDefined();
      const profile = JSON.parse(stored!) as Record<string, unknown>;
      expect(profile['totalTrades']).toBe(1);
    });
  });

  describe('check', () => {
    it('returns no drift when no baseline exists', async () => {
      const result = await detector.check('strat-1', [makeTrade()]);
      expect(result.driftDetected).toBe(false);
      expect(result.driftScore).toBe(0);
      expect(result.driftReasons).toEqual([]);
    });

    it('returns no drift when baseline has zero trades', async () => {
      const profileKey = 'security:drift:profile:strat-1:profile';
      redis.store.set(profileKey, JSON.stringify({
        instrumentDistribution: {},
        totalTrades: 0,
        averageOrderSize: 0,
        averageHoldTimeMinutes: 0,
      }));

      const result = await detector.check('strat-1', [makeTrade()]);
      expect(result.driftDetected).toBe(false);
    });

    it('detects no drift when recent trades match baseline', async () => {
      // Record baseline
      const baselineTrades = Array.from({ length: 10 }, (_, i) =>
        makeTrade({
          tradeId: `trade-${i}`,
          instrument: 'BTC-USDT',
          quantity: 1,
          price: 50000,
          timestamp: new Date(Date.now() - (10 - i) * 60000).toISOString(),
        }),
      );
      for (const trade of baselineTrades) {
        await detector.recordTrade(trade);
      }

      // Check with similar trades
      const recentTrades = Array.from({ length: 5 }, (_, i) =>
        makeTrade({
          tradeId: `recent-${i}`,
          instrument: 'BTC-USDT',
          quantity: 1,
          price: 50000,
          timestamp: new Date(Date.now() + i * 60000).toISOString(),
        }),
      );

      const result = await detector.check('strat-1', recentTrades);
      expect(result.driftDetected).toBe(false);
      expect(result.driftScore).toBeLessThan(0.3);
    });

    it('detects drift when instrument distribution changes', async () => {
      // Baseline: all BTC trades
      const profileKey = 'security:drift:profile:strat-1:profile';
      redis.store.set(profileKey, JSON.stringify({
        instrumentDistribution: { 'BTC-USDT': 100 },
        totalTrades: 100,
        averageOrderSize: 50000,
        averageHoldTimeMinutes: 60,
      }));

      // Recent: all SOL trades (completely different instrument)
      const recentTrades = Array.from({ length: 10 }, (_, i) =>
        makeTrade({
          tradeId: `recent-${i}`,
          instrument: 'SOL-USDT',
          quantity: 1,
          price: 50000,
          timestamp: new Date(Date.now() + i * 3600000).toISOString(),
        }),
      );

      const result = await detector.check('strat-1', recentTrades);
      expect(result.driftDetected).toBe(true);
      expect(result.driftScore).toBeGreaterThan(0);
      expect(result.driftReasons.length).toBeGreaterThan(0);
    });

    it('detects drift when order size deviates significantly', async () => {
      const profileKey = 'security:drift:profile:strat-1:profile';
      redis.store.set(profileKey, JSON.stringify({
        instrumentDistribution: { 'BTC-USDT': 100 },
        totalTrades: 100,
        averageOrderSize: 1000,
        averageHoldTimeMinutes: 60,
      }));

      // Recent trades with 10x order size
      const recentTrades = Array.from({ length: 10 }, (_, i) =>
        makeTrade({
          tradeId: `recent-${i}`,
          instrument: 'BTC-USDT',
          quantity: 10,
          price: 50000,
          timestamp: new Date(Date.now() + i * 3600000).toISOString(),
        }),
      );

      const result = await detector.check('strat-1', recentTrades);
      expect(result.driftScore).toBeGreaterThan(0);
    });

    it('logs warning when drift is detected', async () => {
      const profileKey = 'security:drift:profile:strat-1:profile';
      redis.store.set(profileKey, JSON.stringify({
        instrumentDistribution: { 'BTC-USDT': 100 },
        totalTrades: 100,
        averageOrderSize: 1000,
        averageHoldTimeMinutes: 60,
      }));

      // Use a very low threshold to force drift detection
      const lowThresholdDetector = new StrategyDriftDetector(
        makeConfig({ driftThreshold: 0.01 }),
        logger,
        redis,
      );

      const recentTrades = [
        makeTrade({ instrument: 'SOL-USDT', quantity: 100, price: 100 }),
      ];

      await lowThresholdDetector.check('strat-1', recentTrades);
      expect(logger.warn).toHaveBeenCalledWith(
        'Strategy drift detected',
        expect.objectContaining({ strategyId: 'strat-1' }),
      );
    });

    it('clamps drift score between 0 and 1', async () => {
      const profileKey = 'security:drift:profile:strat-1:profile';
      redis.store.set(profileKey, JSON.stringify({
        instrumentDistribution: { 'BTC-USDT': 100 },
        totalTrades: 100,
        averageOrderSize: 1,
        averageHoldTimeMinutes: 1,
      }));

      const recentTrades = Array.from({ length: 10 }, (_, i) =>
        makeTrade({
          tradeId: `recent-${i}`,
          instrument: 'DOGE-USDT',
          quantity: 10000,
          price: 100000,
          timestamp: new Date(Date.now() + i * 1000 * 60 * 60 * 24).toISOString(),
        }),
      );

      const result = await detector.check('strat-1', recentTrades);
      expect(result.driftScore).toBeGreaterThanOrEqual(0);
      expect(result.driftScore).toBeLessThanOrEqual(1);
    });
  });
});
