import { z } from 'zod';
import Redis from 'ioredis';

// ─── Zod response schemas ──────────────────────────────────────────────────

const RedisStringResponseSchema = z.string();
const RedisNullableStringResponseSchema = z.string().nullable();
const RedisIntResponseSchema = z.number().int();

// ─── RedisAdapter ──────────────────────────────────────────────────────────

export class RedisAdapter {
  private readonly client: Redis;

  constructor(redisUrl: string) {
    // ioredis constructor accepts a URL string but returns an untyped instance
    // at the SDK boundary — we trust the SDK to return a valid Redis client
    this.client = new Redis(redisUrl) as Redis;
  }

  public async get(key: string): Promise<string | null> {
    this.assertDefined('key', key);
    const raw: unknown = await this.client.get(key);
    if (raw === null) {
      return null;
    }
    return RedisNullableStringResponseSchema.parse(raw);
  }

  public async set(key: string, value: string): Promise<void> {
    this.assertDefined('key', key);
    this.assertDefined('value', value);
    await this.client.set(key, value);
  }

  public async setex(key: string, ttlSeconds: number, value: string): Promise<void> {
    this.assertDefined('key', key);
    this.assertDefined('value', value);
    if (ttlSeconds <= 0) {
      throw new Error('ttlSeconds must be a positive integer');
    }
    await this.client.setex(key, ttlSeconds, value);
  }

  public async del(key: string): Promise<void> {
    this.assertDefined('key', key);
    await this.client.del(key);
  }

  public async incr(key: string): Promise<number> {
    this.assertDefined('key', key);
    const raw: unknown = await this.client.incr(key);
    return RedisIntResponseSchema.parse(raw);
  }

  public async expire(key: string, seconds: number): Promise<void> {
    this.assertDefined('key', key);
    if (seconds <= 0) {
      throw new Error('seconds must be a positive integer');
    }
    await this.client.expire(key, seconds);
  }

  public async lpush(key: string, ...values: string[]): Promise<number> {
    this.assertDefined('key', key);
    if (values.length === 0) {
      throw new Error('lpush requires at least one value');
    }
    const raw: unknown = await this.client.lpush(key, ...values);
    return RedisIntResponseSchema.parse(raw);
  }

  public async ltrim(key: string, start: number, stop: number): Promise<void> {
    this.assertDefined('key', key);
    await this.client.ltrim(key, start, stop);
  }

  public async lrange(key: string, start: number, stop: number): Promise<string[]> {
    this.assertDefined('key', key);
    const raw: unknown = await this.client.lrange(key, start, stop);
    return z.array(RedisStringResponseSchema).parse(raw);
  }

  public async zadd(key: string, score: number, member: string): Promise<number> {
    this.assertDefined('key', key);
    this.assertDefined('member', member);
    const raw: unknown = await this.client.zadd(key, score, member);
    return RedisIntResponseSchema.parse(raw);
  }

  public async zremrangebyscore(key: string, min: number, max: number): Promise<number> {
    this.assertDefined('key', key);
    const raw: unknown = await this.client.zremrangebyscore(key, min, max);
    return RedisIntResponseSchema.parse(raw);
  }

  public async zcard(key: string): Promise<number> {
    this.assertDefined('key', key);
    const raw: unknown = await this.client.zcard(key);
    return RedisIntResponseSchema.parse(raw);
  }

  public async hset(key: string, field: string, value: string): Promise<void> {
    this.assertDefined('key', key);
    this.assertDefined('field', field);
    this.assertDefined('value', value);
    await this.client.hset(key, field, value);
  }

  public async hget(key: string, field: string): Promise<string | null> {
    this.assertDefined('key', key);
    this.assertDefined('field', field);
    const raw: unknown = await this.client.hget(key, field);
    if (raw === null) {
      return null;
    }
    return RedisNullableStringResponseSchema.parse(raw);
  }

  public async hdel(key: string, field: string): Promise<void> {
    this.assertDefined('key', key);
    this.assertDefined('field', field);
    await this.client.hdel(key, field);
  }

  public async hgetall(key: string): Promise<Record<string, string>> {
    this.assertDefined('key', key);
    const raw: unknown = await this.client.hgetall(key);
    return z.record(z.string(), z.string()).parse(raw);
  }

  public async healthCheck(): Promise<boolean> {
    try {
      const raw: unknown = await this.client.ping();
      const response = RedisStringResponseSchema.parse(raw);
      return response === 'PONG';
    } catch {
      return false;
    }
  }

  public async shutdown(): Promise<void> {
    await this.client.quit();
  }

  /** Return the underlying ioredis client for advanced use cases. */
  public getClient(): Redis {
    return this.client;
  }

  private assertDefined(paramName: string, value: unknown): void {
    if (value === undefined || value === null) {
      throw new Error(`Parameter "${paramName}" must be defined`);
    }
  }
}
