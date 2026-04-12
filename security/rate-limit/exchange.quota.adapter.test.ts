import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExchangeQuotaAdapter } from './exchange.quota.adapter.js';
import type {
  ExchangeQuotaRedisAdapter,
  ExchangeQuotaLogger,
  ExchangeQuotaConfig,
} from './exchange.quota.adapter.js';
import { SecurityEventType, RiskLevel } from '../types/events.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

function createMockRedis(): ExchangeQuotaRedisAdapter {
  return {
    incr: vi.fn<ExchangeQuotaRedisAdapter['incr']>().mockResolvedValue(1),
    expire: vi.fn<ExchangeQuotaRedisAdapter['expire']>().mockResolvedValue(undefined),
    get: vi.fn<ExchangeQuotaRedisAdapter['get']>().mockResolvedValue(null),
  };
}

function createMockLogger(): ExchangeQuotaLogger {
  return {
    log: vi.fn(),
  };
}

function createConfigs(
  overrides: Partial<ExchangeQuotaConfig> = {},
): ReadonlyMap<string, ExchangeQuotaConfig> {
  const config: ExchangeQuotaConfig = {
    exchangeId: 'binance',
    ordersPerSecond: 10,
    ordersPerDay: 1000,
    warningThresholdPercent: 80,
    ...overrides,
  };
  return new Map([[config.exchangeId, config]]);
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('ExchangeQuotaAdapter', () => {
  let redis: ReturnType<typeof createMockRedis>;
  let logger: ReturnType<typeof createMockLogger>;
  let adapter: ExchangeQuotaAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = createMockRedis();
    logger = createMockLogger();
    adapter = new ExchangeQuotaAdapter(createConfigs(), redis, logger);
  });

  // ── recordOrderSent ────────────────────────────────────────────────────

  describe('recordOrderSent', () => {
    it('increments per-second and per-day counters', async () => {
      await adapter.recordOrderSent('binance');

      expect(redis.incr).toHaveBeenCalledTimes(2);
      expect(redis.incr).toHaveBeenCalledWith('exchange:quota:sec:binance');
      expect(redis.incr).toHaveBeenCalledWith('exchange:quota:day:binance');
    });

    it('sets 1s TTL on per-second key when counter is 1', async () => {
      vi.mocked(redis.incr)
        .mockResolvedValueOnce(1) // sec counter = 1 (first)
        .mockResolvedValueOnce(1); // day counter = 1 (first)

      await adapter.recordOrderSent('binance');

      expect(redis.expire).toHaveBeenCalledWith('exchange:quota:sec:binance', 1);
    });

    it('sets 86400s TTL on per-day key when counter is 1', async () => {
      vi.mocked(redis.incr)
        .mockResolvedValueOnce(1) // sec
        .mockResolvedValueOnce(1); // day

      await adapter.recordOrderSent('binance');

      expect(redis.expire).toHaveBeenCalledWith('exchange:quota:day:binance', 86400);
    });

    it('does not set TTL when counter is greater than 1', async () => {
      vi.mocked(redis.incr)
        .mockResolvedValueOnce(5) // sec counter already existed
        .mockResolvedValueOnce(100); // day counter already existed

      await adapter.recordOrderSent('binance');

      expect(redis.expire).not.toHaveBeenCalled();
    });

    it('emits EXCHANGE_QUOTA_WARNING when warning threshold crossed', async () => {
      vi.mocked(redis.incr)
        .mockResolvedValueOnce(5) // sec
        .mockResolvedValueOnce(800); // day: 800/1000 = 80% >= 80% threshold

      await adapter.recordOrderSent('binance');

      expect(logger.log).toHaveBeenCalledOnce();
      const event = vi.mocked(logger.log).mock.calls[0][0];
      expect(event.eventType).toBe(SecurityEventType.EXCHANGE_QUOTA_WARNING);
      expect(event.riskLevel).toBe(RiskLevel.MEDIUM);
      expect(event.payload).toEqual(
        expect.objectContaining({
          exchange: 'binance',
          usedPercent: 80,
          remainingRequests: 200,
        }),
      );
    });

    it('emits warning when exactly at threshold', async () => {
      // 80% threshold, 1000 daily limit, 800 orders = exactly 80%
      vi.mocked(redis.incr)
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(800);

      await adapter.recordOrderSent('binance');

      expect(logger.log).toHaveBeenCalledOnce();
    });

    it('does not emit warning when below threshold', async () => {
      vi.mocked(redis.incr)
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(799); // 79.9% < 80%

      await adapter.recordOrderSent('binance');

      expect(logger.log).not.toHaveBeenCalled();
    });

    it('throws for unknown exchange', async () => {
      await expect(adapter.recordOrderSent('unknown-exchange')).rejects.toThrow(
        'No quota config found for exchange "unknown-exchange"',
      );
    });
  });

  // ── canSendOrder ───────────────────────────────────────────────────────

  describe('canSendOrder', () => {
    it('returns allowed when both quotas have capacity', async () => {
      vi.mocked(redis.get)
        .mockResolvedValueOnce('3') // sec: 3 used, limit 10
        .mockResolvedValueOnce('500'); // day: 500 used, limit 1000

      const result = await adapter.canSendOrder('binance');

      expect(result.allowed).toBe(true);
      expect(result.secondsRemaining).toBe(7);
      expect(result.dailyRemaining).toBe(500);
      expect(result.warning).toBe(false);
    });

    it('returns not allowed when per-second quota exhausted', async () => {
      vi.mocked(redis.get)
        .mockResolvedValueOnce('10') // sec: 10/10 = full
        .mockResolvedValueOnce('100'); // day: 100/1000

      const result = await adapter.canSendOrder('binance');

      expect(result.allowed).toBe(false);
      expect(result.secondsRemaining).toBe(0);
      expect(result.dailyRemaining).toBe(900);
    });

    it('returns not allowed when per-day quota exhausted', async () => {
      vi.mocked(redis.get)
        .mockResolvedValueOnce('1') // sec: 1/10
        .mockResolvedValueOnce('1000'); // day: 1000/1000 = full

      const result = await adapter.canSendOrder('binance');

      expect(result.allowed).toBe(false);
      expect(result.secondsRemaining).toBe(9);
      expect(result.dailyRemaining).toBe(0);
    });

    it('returns allowed with full capacity when counters are null', async () => {
      vi.mocked(redis.get)
        .mockResolvedValueOnce(null) // no sec key
        .mockResolvedValueOnce(null); // no day key

      const result = await adapter.canSendOrder('binance');

      expect(result.allowed).toBe(true);
      expect(result.secondsRemaining).toBe(10);
      expect(result.dailyRemaining).toBe(1000);
      expect(result.warning).toBe(false);
    });

    it('sets warning flag when above warning threshold', async () => {
      vi.mocked(redis.get)
        .mockResolvedValueOnce('1') // sec
        .mockResolvedValueOnce('850'); // day: 85% >= 80%

      const result = await adapter.canSendOrder('binance');

      expect(result.warning).toBe(true);
    });

    it('does not set warning flag when below threshold', async () => {
      vi.mocked(redis.get)
        .mockResolvedValueOnce('1')
        .mockResolvedValueOnce('700'); // 70% < 80%

      const result = await adapter.canSendOrder('binance');

      expect(result.warning).toBe(false);
    });

    it('throws for unknown exchange', async () => {
      await expect(adapter.canSendOrder('nonexistent')).rejects.toThrow(
        'No quota config found for exchange "nonexistent"',
      );
    });

    it('returns not allowed when both quotas exhausted', async () => {
      vi.mocked(redis.get)
        .mockResolvedValueOnce('10') // sec: full
        .mockResolvedValueOnce('1000'); // day: full

      const result = await adapter.canSendOrder('binance');

      expect(result.allowed).toBe(false);
      expect(result.secondsRemaining).toBe(0);
      expect(result.dailyRemaining).toBe(0);
      expect(result.warning).toBe(true);
    });
  });

  // ── Multiple exchanges ─────────────────────────────────────────────────

  describe('multiple exchanges', () => {
    it('supports multiple exchange configs', async () => {
      const multiConfigs = new Map<string, ExchangeQuotaConfig>([
        [
          'binance',
          {
            exchangeId: 'binance',
            ordersPerSecond: 10,
            ordersPerDay: 1000,
            warningThresholdPercent: 80,
          },
        ],
        [
          'coinbase',
          {
            exchangeId: 'coinbase',
            ordersPerSecond: 5,
            ordersPerDay: 500,
            warningThresholdPercent: 90,
          },
        ],
      ]);

      const multiAdapter = new ExchangeQuotaAdapter(multiConfigs, redis, logger);

      vi.mocked(redis.get)
        .mockResolvedValueOnce('2')
        .mockResolvedValueOnce('100');

      const result = await multiAdapter.canSendOrder('coinbase');

      expect(result.allowed).toBe(true);
      expect(result.secondsRemaining).toBe(3); // 5 - 2
      expect(result.dailyRemaining).toBe(400); // 500 - 100
    });
  });

  // ── Edge case: warning threshold at 0% ─────────────────────────────────

  describe('edge cases', () => {
    it('always warns when threshold is 0%', async () => {
      const zeroThresholdAdapter = new ExchangeQuotaAdapter(
        createConfigs({ warningThresholdPercent: 0 }),
        redis,
        logger,
      );

      vi.mocked(redis.incr)
        .mockResolvedValueOnce(1) // sec
        .mockResolvedValueOnce(1); // day: 0.1% >= 0%

      await zeroThresholdAdapter.recordOrderSent('binance');

      expect(logger.log).toHaveBeenCalledOnce();
    });

    it('handles over-limit counts gracefully (remaining floors to 0)', async () => {
      vi.mocked(redis.get)
        .mockResolvedValueOnce('15') // over sec limit of 10
        .mockResolvedValueOnce('1200'); // over day limit of 1000

      const result = await adapter.canSendOrder('binance');

      expect(result.allowed).toBe(false);
      expect(result.secondsRemaining).toBe(0);
      expect(result.dailyRemaining).toBe(0);
    });
  });
});
