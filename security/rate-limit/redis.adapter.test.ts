import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RedisAdapter } from './redis.adapter.js';

// ─── Mock ioredis ──────────────────────────────────────────────────────────

const mockRedisInstance = {
  get: vi.fn(),
  set: vi.fn(),
  setex: vi.fn(),
  del: vi.fn(),
  incr: vi.fn(),
  expire: vi.fn(),
  lpush: vi.fn(),
  ltrim: vi.fn(),
  lrange: vi.fn(),
  zadd: vi.fn(),
  zremrangebyscore: vi.fn(),
  zcard: vi.fn(),
  hset: vi.fn(),
  hget: vi.fn(),
  hdel: vi.fn(),
  hgetall: vi.fn(),
  ping: vi.fn(),
  quit: vi.fn(),
};

vi.mock('ioredis', () => {
  return {
    default: vi.fn(() => mockRedisInstance),
  };
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('RedisAdapter', () => {
  let adapter: RedisAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new RedisAdapter('redis://localhost:6379');
  });

  // ── get ────────────────────────────────────────────────────────────────

  describe('get', () => {
    it('returns string value when key exists', async () => {
      mockRedisInstance.get.mockResolvedValue('hello');
      const result = await adapter.get('mykey');
      expect(result).toBe('hello');
      expect(mockRedisInstance.get).toHaveBeenCalledWith('mykey');
    });

    it('returns null when key does not exist', async () => {
      mockRedisInstance.get.mockResolvedValue(null);
      const result = await adapter.get('missing');
      expect(result).toBeNull();
    });

    it('throws when key is undefined', async () => {
      await expect(adapter.get(undefined as unknown as string)).rejects.toThrow(
        'Parameter "key" must be defined',
      );
    });
  });

  // ── set ────────────────────────────────────────────────────────────────

  describe('set', () => {
    it('sets a value', async () => {
      mockRedisInstance.set.mockResolvedValue('OK');
      await adapter.set('k', 'v');
      expect(mockRedisInstance.set).toHaveBeenCalledWith('k', 'v');
    });

    it('throws when key is undefined', async () => {
      await expect(adapter.set(undefined as unknown as string, 'v')).rejects.toThrow(
        'Parameter "key" must be defined',
      );
    });

    it('throws when value is undefined', async () => {
      await expect(adapter.set('k', undefined as unknown as string)).rejects.toThrow(
        'Parameter "value" must be defined',
      );
    });
  });

  // ── setex ──────────────────────────────────────────────────────────────

  describe('setex', () => {
    it('sets a value with TTL', async () => {
      mockRedisInstance.setex.mockResolvedValue('OK');
      await adapter.setex('k', 60, 'v');
      expect(mockRedisInstance.setex).toHaveBeenCalledWith('k', 60, 'v');
    });

    it('throws when ttlSeconds is not positive', async () => {
      await expect(adapter.setex('k', 0, 'v')).rejects.toThrow(
        'ttlSeconds must be a positive integer',
      );
    });

    it('throws when ttlSeconds is negative', async () => {
      await expect(adapter.setex('k', -5, 'v')).rejects.toThrow(
        'ttlSeconds must be a positive integer',
      );
    });
  });

  // ── del ────────────────────────────────────────────────────────────────

  describe('del', () => {
    it('deletes a key', async () => {
      mockRedisInstance.del.mockResolvedValue(1);
      await adapter.del('k');
      expect(mockRedisInstance.del).toHaveBeenCalledWith('k');
    });

    it('throws when key is undefined', async () => {
      await expect(adapter.del(undefined as unknown as string)).rejects.toThrow(
        'Parameter "key" must be defined',
      );
    });
  });

  // ── incr ───────────────────────────────────────────────────────────────

  describe('incr', () => {
    it('increments and returns the new value', async () => {
      mockRedisInstance.incr.mockResolvedValue(5);
      const result = await adapter.incr('counter');
      expect(result).toBe(5);
    });

    it('throws when key is undefined', async () => {
      await expect(adapter.incr(undefined as unknown as string)).rejects.toThrow(
        'Parameter "key" must be defined',
      );
    });
  });

  // ── expire ─────────────────────────────────────────────────────────────

  describe('expire', () => {
    it('sets expiry on a key', async () => {
      mockRedisInstance.expire.mockResolvedValue(1);
      await adapter.expire('k', 120);
      expect(mockRedisInstance.expire).toHaveBeenCalledWith('k', 120);
    });

    it('throws when seconds is not positive', async () => {
      await expect(adapter.expire('k', 0)).rejects.toThrow(
        'seconds must be a positive integer',
      );
    });
  });

  // ── lpush ──────────────────────────────────────────────────────────────

  describe('lpush', () => {
    it('pushes values and returns length', async () => {
      mockRedisInstance.lpush.mockResolvedValue(3);
      const result = await adapter.lpush('list', 'a', 'b');
      expect(result).toBe(3);
      expect(mockRedisInstance.lpush).toHaveBeenCalledWith('list', 'a', 'b');
    });

    it('throws when no values provided', async () => {
      await expect(adapter.lpush('list')).rejects.toThrow(
        'lpush requires at least one value',
      );
    });
  });

  // ── ltrim ──────────────────────────────────────────────────────────────

  describe('ltrim', () => {
    it('trims a list', async () => {
      mockRedisInstance.ltrim.mockResolvedValue('OK');
      await adapter.ltrim('list', 0, 9);
      expect(mockRedisInstance.ltrim).toHaveBeenCalledWith('list', 0, 9);
    });
  });

  // ── lrange ─────────────────────────────────────────────────────────────

  describe('lrange', () => {
    it('returns range of list elements', async () => {
      mockRedisInstance.lrange.mockResolvedValue(['a', 'b', 'c']);
      const result = await adapter.lrange('list', 0, -1);
      expect(result).toEqual(['a', 'b', 'c']);
    });

    it('returns empty array for empty list', async () => {
      mockRedisInstance.lrange.mockResolvedValue([]);
      const result = await adapter.lrange('list', 0, -1);
      expect(result).toEqual([]);
    });
  });

  // ── zadd ───────────────────────────────────────────────────────────────

  describe('zadd', () => {
    it('adds a member with score and returns count', async () => {
      mockRedisInstance.zadd.mockResolvedValue(1);
      const result = await adapter.zadd('zset', 100, 'member1');
      expect(result).toBe(1);
      expect(mockRedisInstance.zadd).toHaveBeenCalledWith('zset', 100, 'member1');
    });

    it('throws when member is undefined', async () => {
      await expect(
        adapter.zadd('zset', 100, undefined as unknown as string),
      ).rejects.toThrow('Parameter "member" must be defined');
    });
  });

  // ── zremrangebyscore ───────────────────────────────────────────────────

  describe('zremrangebyscore', () => {
    it('removes members in score range and returns count', async () => {
      mockRedisInstance.zremrangebyscore.mockResolvedValue(2);
      const result = await adapter.zremrangebyscore('zset', 0, 50);
      expect(result).toBe(2);
      expect(mockRedisInstance.zremrangebyscore).toHaveBeenCalledWith('zset', 0, 50);
    });
  });

  // ── zcard ──────────────────────────────────────────────────────────────

  describe('zcard', () => {
    it('returns cardinality of sorted set', async () => {
      mockRedisInstance.zcard.mockResolvedValue(10);
      const result = await adapter.zcard('zset');
      expect(result).toBe(10);
    });
  });

  // ── hset ───────────────────────────────────────────────────────────────

  describe('hset', () => {
    it('sets a hash field', async () => {
      mockRedisInstance.hset.mockResolvedValue(1);
      await adapter.hset('hash', 'field', 'value');
      expect(mockRedisInstance.hset).toHaveBeenCalledWith('hash', 'field', 'value');
    });

    it('throws when field is undefined', async () => {
      await expect(
        adapter.hset('hash', undefined as unknown as string, 'value'),
      ).rejects.toThrow('Parameter "field" must be defined');
    });
  });

  // ── hget ───────────────────────────────────────────────────────────────

  describe('hget', () => {
    it('returns hash field value', async () => {
      mockRedisInstance.hget.mockResolvedValue('val');
      const result = await adapter.hget('hash', 'field');
      expect(result).toBe('val');
    });

    it('returns null when field does not exist', async () => {
      mockRedisInstance.hget.mockResolvedValue(null);
      const result = await adapter.hget('hash', 'missing');
      expect(result).toBeNull();
    });
  });

  // ── hdel ───────────────────────────────────────────────────────────────

  describe('hdel', () => {
    it('deletes a hash field', async () => {
      mockRedisInstance.hdel.mockResolvedValue(1);
      await adapter.hdel('hash', 'field');
      expect(mockRedisInstance.hdel).toHaveBeenCalledWith('hash', 'field');
    });
  });

  // ── hgetall ────────────────────────────────────────────────────────────

  describe('hgetall', () => {
    it('returns all hash fields', async () => {
      mockRedisInstance.hgetall.mockResolvedValue({ a: '1', b: '2' });
      const result = await adapter.hgetall('hash');
      expect(result).toEqual({ a: '1', b: '2' });
    });

    it('returns empty object for empty hash', async () => {
      mockRedisInstance.hgetall.mockResolvedValue({});
      const result = await adapter.hgetall('hash');
      expect(result).toEqual({});
    });
  });

  // ── healthCheck ────────────────────────────────────────────────────────

  describe('healthCheck', () => {
    it('returns true when Redis responds with PONG', async () => {
      mockRedisInstance.ping.mockResolvedValue('PONG');
      const result = await adapter.healthCheck();
      expect(result).toBe(true);
    });

    it('returns false when Redis responds with unexpected value', async () => {
      mockRedisInstance.ping.mockResolvedValue('NOT_PONG');
      const result = await adapter.healthCheck();
      expect(result).toBe(false);
    });

    it('returns false when Redis throws', async () => {
      mockRedisInstance.ping.mockRejectedValue(new Error('Connection refused'));
      const result = await adapter.healthCheck();
      expect(result).toBe(false);
    });
  });

  // ── shutdown ───────────────────────────────────────────────────────────

  describe('shutdown', () => {
    it('calls quit on the Redis client', async () => {
      mockRedisInstance.quit.mockResolvedValue('OK');
      await adapter.shutdown();
      expect(mockRedisInstance.quit).toHaveBeenCalledOnce();
    });
  });
});
