import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConsensusRedisAdapter, ConsensusLogger } from './feed.consensus.js';
import { FeedConsensus } from './feed.consensus.js';
import type { SecurityConfig } from '../types/config.js';
import { SecurityEventType, RiskLevel } from '../types/events.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeConfig(
  overrides: Partial<SecurityConfig> = {},
): SecurityConfig {
  return {
    feedConsensusDivergenceThresholdPercent: 1.5,
    ...overrides,
  } as unknown as SecurityConfig; // minimal stub for tests
}

function makeLogger(): ConsensusLogger & { log: ReturnType<typeof vi.fn> } {
  return { log: vi.fn() };
}

function makeRedis(): ConsensusRedisAdapter & Record<string, ReturnType<typeof vi.fn>> {
  const store = new Map<string, string>();
  const hashStore = new Map<string, Map<string, string>>();

  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
    }),
    del: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    hset: vi.fn(async (key: string, field: string, value: string) => {
      if (!hashStore.has(key)) hashStore.set(key, new Map());
      hashStore.get(key)!.set(field, value);
    }),
    hget: vi.fn(async (key: string, field: string) => {
      return hashStore.get(key)?.get(field) ?? null;
    }),
    hgetall: vi.fn(async (key: string) => {
      const m = hashStore.get(key);
      if (!m) return {};
      const result: Record<string, string> = {};
      for (const [k, v] of m) {
        result[k] = v;
      }
      return result;
    }),
    hdel: vi.fn(async (key: string, field: string) => {
      hashStore.get(key)?.delete(field);
    }),
    lpush: vi.fn(async () => undefined),
    ltrim: vi.fn(async () => undefined),
    lrange: vi.fn(async () => []),
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('FeedConsensus', () => {
  let config: SecurityConfig;
  let logger: ReturnType<typeof makeLogger>;
  let redis: ReturnType<typeof makeRedis>;
  let consensus: FeedConsensus;

  beforeEach(() => {
    config = makeConfig();
    logger = makeLogger();
    redis = makeRedis();
    consensus = new FeedConsensus(config, logger, redis);
  });

  it('should return consensus: true when only one source exists', async () => {
    const result = await consensus.check('BTC-USDT', 50_000, 'binance');

    expect(result.consensus).toBe(true);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toEqual({ name: 'binance', price: 50_000 });
    expect(result.divergencePercent).toBe(0);
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('should return consensus: true when two sources agree within threshold', async () => {
    // Two sources within 1.5% divergence
    await consensus.check('BTC-USDT', 50_000, 'binance');
    const result = await consensus.check('BTC-USDT', 50_500, 'coinbase');

    expect(result.consensus).toBe(true);
    expect(result.sources).toHaveLength(2);
    // 50500 - 50000 = 500; 500/50000 = 1.0%
    expect(result.divergencePercent).toBe(1.0);
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('should return consensus: false when two sources diverge beyond threshold', async () => {
    // Two sources with > 1.5% divergence
    await consensus.check('BTC-USDT', 50_000, 'binance');
    const result = await consensus.check('BTC-USDT', 51_000, 'coinbase');

    // 51000 - 50000 = 1000; 1000/50000 = 2.0%
    expect(result.consensus).toBe(false);
    expect(result.sources).toHaveLength(2);
    expect(result.divergencePercent).toBe(2.0);

    expect(logger.log).toHaveBeenCalledOnce();
    expect(logger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: SecurityEventType.FEED_CONSENSUS_FAILURE,
        riskLevel: RiskLevel.HIGH,
        payload: expect.objectContaining({
          instrument: 'BTC-USDT',
          divergencePercent: 2.0,
          threshold: 1.5,
        }),
      }),
    );
  });

  it('should handle expired source by cleaning up hash entry', async () => {
    // First source stored normally
    await consensus.check('ETH-USDT', 3_000, 'binance');

    // Simulate coinbase price expired: the hgetall returns it but get returns null
    redis.hset.mockImplementation(async (key: string, field: string, value: string) => {
      // Maintain the original behavior for the sources hash
      const m = new Map<string, string>();
      m.set('binance', '1');
      m.set('coinbase', '1');
      // We need to update the internal hgetall response
    });

    // Override hgetall to return both sources
    redis.hgetall.mockImplementation(async (key: string) => {
      if (key.includes('sources')) {
        return { binance: '1', coinbase: '1' };
      }
      return {};
    });

    // Override get: binance returns price, coinbase returns null (expired)
    redis.get.mockImplementation(async (key: string) => {
      if (key.includes('binance')) return '3000';
      return null;
    });

    const result = await consensus.check('ETH-USDT', 3_000, 'binance');

    // Only binance is alive, so consensus is true (single source)
    expect(result.consensus).toBe(true);
    expect(result.sources).toHaveLength(1);
    expect(redis.hdel).toHaveBeenCalled();
  });

  it('should store price with setex for TTL-based expiration', async () => {
    await consensus.check('BTC-USDT', 50_000, 'binance');

    expect(redis.setex).toHaveBeenCalledWith(
      'feed:consensus:BTC-USDT:binance',
      30,
      '50000',
    );
  });
});
