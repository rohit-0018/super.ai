import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AnomalyRedisAdapter, AnomalyLogger } from './anomaly.filter.js';
import { AnomalyFilter } from './anomaly.filter.js';
import type { SecurityConfig } from '../types/config.js';
import { SecurityEventType, RiskLevel } from '../types/events.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeConfig(
  overrides: Partial<SecurityConfig> = {},
): SecurityConfig {
  return {
    anomalyStdDevMultiplier: 3,
    anomalyWindowSize: 100,
    ...overrides,
  } as unknown as SecurityConfig;
}

function makeLogger(): AnomalyLogger & { log: ReturnType<typeof vi.fn> } {
  return { log: vi.fn() };
}

function makeRedis(): AnomalyRedisAdapter & Record<string, ReturnType<typeof vi.fn>> {
  const lists = new Map<string, string[]>();

  return {
    lpush: vi.fn(async (key: string, value: string) => {
      if (!lists.has(key)) lists.set(key, []);
      lists.get(key)!.unshift(value);
    }),
    ltrim: vi.fn(async (key: string, start: number, stop: number) => {
      const list = lists.get(key);
      if (list) {
        const end = stop < 0 ? list.length : stop + 1;
        lists.set(key, list.slice(start, end));
      }
    }),
    lrange: vi.fn(async (key: string, start: number, stop: number) => {
      const list = lists.get(key) ?? [];
      const end = stop < 0 ? list.length : stop + 1;
      return list.slice(start, end);
    }),
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('AnomalyFilter', () => {
  let config: SecurityConfig;
  let logger: ReturnType<typeof makeLogger>;
  let redis: ReturnType<typeof makeRedis>;
  let filter: AnomalyFilter;

  beforeEach(() => {
    config = makeConfig();
    logger = makeLogger();
    redis = makeRedis();
    filter = new AnomalyFilter(config, logger, redis);
  });

  it('should return not anomalous with empty window', async () => {
    const result = await filter.check('BTC-USDT', 50_000);

    expect(result.anomalous).toBe(false);
    expect(result.stdDev).toBe(0);
    expect(result.deviations).toBe(0);
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('should return not anomalous with only one prior data point', async () => {
    await filter.check('BTC-USDT', 50_000);
    const result = await filter.check('BTC-USDT', 50_100);

    expect(result.anomalous).toBe(false);
    expect(result.stdDev).toBe(0);
    expect(result.deviations).toBe(0);
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('should return not anomalous when price is within threshold', async () => {
    // Build up a window of stable prices
    for (let i = 0; i < 10; i++) {
      await filter.check('BTC-USDT', 50_000 + i * 10);
    }

    // Price close to the mean
    const result = await filter.check('BTC-USDT', 50_050);

    expect(result.anomalous).toBe(false);
    expect(result.mean).toBeGreaterThan(0);
    expect(result.stdDev).toBeGreaterThan(0);
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('should detect anomaly when price deviates beyond multiplier * stdDev', async () => {
    // Build a window of stable prices around 100 with slight variance
    const basePrices = [
      99, 101, 100, 102, 98, 100, 101, 99, 100, 101,
      100, 99, 101, 100, 98, 102, 100, 99, 101, 100,
    ];
    for (const p of basePrices) {
      await filter.check('BTC-USDT', p);
    }

    // Extreme outlier: 200 is many stdDevs from mean ~100
    const result = await filter.check('BTC-USDT', 200);

    expect(result.anomalous).toBe(true);
    expect(result.deviations).toBeGreaterThan(3);
    expect(logger.log).toHaveBeenCalledOnce();
    expect(logger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: SecurityEventType.FEED_ANOMALY_DETECTED,
        riskLevel: RiskLevel.HIGH,
        payload: expect.objectContaining({
          instrument: 'BTC-USDT',
          currentValue: 200,
        }),
      }),
    );
  });

  it('should add price to window after check', async () => {
    await filter.check('BTC-USDT', 50_000);

    expect(redis.lpush).toHaveBeenCalledWith(
      'feed:anomaly:BTC-USDT',
      '50000',
    );
  });

  it('should trim window to max configured size', async () => {
    config = makeConfig({ anomalyWindowSize: 5 } as Partial<SecurityConfig>);
    filter = new AnomalyFilter(config, logger, redis);

    for (let i = 0; i < 10; i++) {
      await filter.check('BTC-USDT', 50_000 + i);
    }

    expect(redis.ltrim).toHaveBeenLastCalledWith(
      'feed:anomaly:BTC-USDT',
      0,
      4,
    );
  });

  it('should handle zero stdDev gracefully (all identical prices)', async () => {
    for (let i = 0; i < 5; i++) {
      await filter.check('BTC-USDT', 100);
    }

    // Same price, stdDev is 0, deviations should be 0
    const result = await filter.check('BTC-USDT', 100);

    expect(result.anomalous).toBe(false);
    expect(result.stdDev).toBe(0);
    expect(result.deviations).toBe(0);
  });
});
