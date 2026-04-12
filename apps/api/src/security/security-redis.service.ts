import { Injectable, OnModuleDestroy, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Dedicated Redis connection for the security module.
 * Implements the RedisAdapter interface required by all @super-ai/security components.
 */
@Injectable()
export class SecurityRedisService implements OnModuleDestroy {
  private readonly logger = new Logger(SecurityRedisService.name);
  private readonly client: Redis;

  constructor(@Optional() private readonly config?: ConfigService) {
    const redisUrl = this.config?.get<string>('REDIS_URL') ?? process.env.REDIS_URL ?? 'redis://localhost:6379';
    this.client = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      keyPrefix: 'sec:',
      lazyConnect: true,
    });

    this.client.on('error', (err) => {
      this.logger.error(`Security Redis error: ${err.message}`);
    });

    this.client.on('connect', () => {
      this.logger.log('Security Redis connected');
    });

    // Connect eagerly but don't block constructor
    this.client.connect().catch((err) => {
      this.logger.warn(`Security Redis initial connect failed (will retry): ${err.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log('Disconnecting security Redis');
    await this.client.quit().catch(() => {
      /* swallow close errors */
    });
  }

  // ── RedisAdapter interface ──────────────────────────────────────────────

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds !== undefined && ttlSeconds > 0) {
      await this.client.setex(key, ttlSeconds, value);
    } else {
      await this.client.set(key, value);
    }
  }

  async setex(key: string, ttlSeconds: number, value: string): Promise<void> {
    await this.client.setex(key, ttlSeconds, value);
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async incr(key: string): Promise<number> {
    return this.client.incr(key);
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    await this.client.expire(key, ttlSeconds);
  }

  async ttl(key: string): Promise<number> {
    return this.client.ttl(key);
  }

  async hset(key: string, field: string, value: string): Promise<void> {
    await this.client.hset(key, field, value);
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.client.hget(key, field);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return this.client.hgetall(key);
  }

  async hdel(key: string, field: string): Promise<void> {
    await this.client.hdel(key, field);
  }

  async lpush(key: string, value: string): Promise<number> {
    return this.client.lpush(key, value);
  }

  async ltrim(key: string, start: number, stop: number): Promise<void> {
    await this.client.ltrim(key, start, stop);
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.client.lrange(key, start, stop);
  }
}
