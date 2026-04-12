import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RateLimiter } from './rate.limiter.js';
import type {
  RateLimiterRedisAdapter,
  RateLimiterLogger,
  RateLimitIdentifier,
} from './rate.limiter.js';
import { SecurityEventType, RiskLevel } from '../types/events.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

function createMockRedis(): RateLimiterRedisAdapter {
  return {
    zadd: vi.fn<RateLimiterRedisAdapter['zadd']>().mockResolvedValue(1),
    zremrangebyscore: vi.fn<RateLimiterRedisAdapter['zremrangebyscore']>().mockResolvedValue(0),
    zcard: vi.fn<RateLimiterRedisAdapter['zcard']>().mockResolvedValue(0),
    expire: vi.fn<RateLimiterRedisAdapter['expire']>().mockResolvedValue(undefined),
  };
}

function createMockLogger(): RateLimiterLogger {
  return {
    log: vi.fn(),
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('RateLimiter', () => {
  let redis: ReturnType<typeof createMockRedis>;
  let logger: ReturnType<typeof createMockLogger>;
  let limiter: RateLimiter;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = createMockRedis();
    logger = createMockLogger();
    limiter = new RateLimiter(redis, logger);
  });

  describe('check', () => {
    it('allows requests under the limit', async () => {
      // zcard returns 3 (under limit of 10)
      vi.mocked(redis.zcard).mockResolvedValue(3);

      const result = await limiter.check('user:abc', 10, 60_000);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(6); // 10 - 3 - 1 = 6
      expect(result.resetAt).toBeInstanceOf(Date);
      expect(redis.zremrangebyscore).toHaveBeenCalledOnce();
      expect(redis.zadd).toHaveBeenCalledOnce();
      expect(redis.expire).toHaveBeenCalledOnce();
    });

    it('allows the first request when count is zero', async () => {
      vi.mocked(redis.zcard).mockResolvedValue(0);

      const result = await limiter.check('user:new', 5, 60_000);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4); // 5 - 0 - 1 = 4
      expect(redis.zadd).toHaveBeenCalledOnce();
    });

    it('blocks requests at the limit', async () => {
      vi.mocked(redis.zcard).mockResolvedValue(10);

      const result = await limiter.check('user:busy', 10, 60_000);

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      // Should NOT add a new entry
      expect(redis.zadd).not.toHaveBeenCalled();
    });

    it('blocks requests over the limit', async () => {
      vi.mocked(redis.zcard).mockResolvedValue(15);

      const result = await limiter.check('user:overloaded', 10, 60_000);

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(redis.zadd).not.toHaveBeenCalled();
    });

    it('emits RATE_LIMIT_BREACHED event when limit is hit', async () => {
      vi.mocked(redis.zcard).mockResolvedValue(10);

      await limiter.check('user:breached', 10, 60_000);

      expect(logger.log).toHaveBeenCalledOnce();
      const logCall = vi.mocked(logger.log).mock.calls[0][0];
      expect(logCall.eventType).toBe(SecurityEventType.RATE_LIMIT_BREACHED);
      expect(logCall.riskLevel).toBe(RiskLevel.MEDIUM);
      expect(logCall.payload).toEqual(
        expect.objectContaining({
          identifier: 'user:breached',
          requestCount: 10,
          limit: 10,
          windowMs: 60_000,
        }),
      );
    });

    it('does not emit event when request is allowed', async () => {
      vi.mocked(redis.zcard).mockResolvedValue(5);

      await limiter.check('user:ok', 10, 60_000);

      expect(logger.log).not.toHaveBeenCalled();
    });

    it('removes stale entries before checking', async () => {
      vi.mocked(redis.zcard).mockResolvedValue(2);
      const now = Date.now();

      await limiter.check('user:stale', 10, 30_000);

      expect(redis.zremrangebyscore).toHaveBeenCalledOnce();
      const [key, min, max] = vi.mocked(redis.zremrangebyscore).mock.calls[0];
      expect(key).toBe('user:stale');
      expect(min).toBe(0);
      // max should be approximately now - 30000
      expect(max).toBeGreaterThan(now - 31_000);
      expect(max).toBeLessThanOrEqual(now);
    });

    it('sets expire on sorted set key equal to window in seconds', async () => {
      vi.mocked(redis.zcard).mockResolvedValue(0);

      await limiter.check('user:ttl', 10, 90_000);

      expect(redis.expire).toHaveBeenCalledWith('user:ttl', 90);
    });

    it('allows exactly limit - 1 when one request away from limit', async () => {
      vi.mocked(redis.zcard).mockResolvedValue(9);

      const result = await limiter.check('user:edge', 10, 60_000);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(0); // 10 - 9 - 1 = 0
    });
  });

  describe('checkAll', () => {
    it('checks all identifiers and returns results in order', async () => {
      // First call: count 0 (allowed), second call: count 10 (blocked)
      vi.mocked(redis.zcard)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(10);

      const identifiers: RateLimitIdentifier[] = [
        { key: 'user:a', limit: 5, windowMs: 60_000 },
        { key: 'user:b', limit: 10, windowMs: 60_000 },
      ];

      const results = await limiter.checkAll(identifiers);

      expect(results).toHaveLength(2);
      expect(results[0].allowed).toBe(true);
      expect(results[1].allowed).toBe(false);
    });

    it('returns empty array for empty identifiers', async () => {
      const results = await limiter.checkAll([]);
      expect(results).toEqual([]);
    });

    it('emits events only for breached identifiers', async () => {
      vi.mocked(redis.zcard)
        .mockResolvedValueOnce(2) // allowed
        .mockResolvedValueOnce(5) // blocked (limit 5)
        .mockResolvedValueOnce(1); // allowed

      const identifiers: RateLimitIdentifier[] = [
        { key: 'a', limit: 10, windowMs: 60_000 },
        { key: 'b', limit: 5, windowMs: 60_000 },
        { key: 'c', limit: 10, windowMs: 60_000 },
      ];

      await limiter.checkAll(identifiers);

      expect(logger.log).toHaveBeenCalledOnce();
      const logPayload = vi.mocked(logger.log).mock.calls[0][0].payload;
      expect(logPayload).toEqual(
        expect.objectContaining({ identifier: 'b' }),
      );
    });
  });
});
