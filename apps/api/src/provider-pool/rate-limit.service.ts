import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { buildRedisOptions } from '../common/redis-options';

/**
 * Redis-backed sliding-window rate limiter for external API providers.
 *
 * Key schema (all prefixed "rl:"):
 *   rl:cnt:{key}:{windowSlot}   INCR counter, TTL = 2 × windowSec
 *   rl:cd:{key}                 Cooldown sentinel, TTL = cooldownSec
 *
 * windowSlot = floor(unixSeconds / windowSec)  — one bucket per window.
 */
@Injectable()
export class RateLimitService implements OnModuleDestroy {
  private readonly logger = new Logger(RateLimitService.name);
  private readonly redis: Redis;

  constructor() {
    // Rate limiter intentionally keeps offline-queue OFF — if Redis is down we
    // want the rate-check to fail fast so the caller can fall back, not block
    // request handling.
    this.redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', buildRedisOptions({
      keyPrefix: 'rl:',
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      lazyConnect: true,
    }));
    this.redis.on('error', (e) => this.logger.warn(`RateLimit Redis error: ${e.message}`));
    this.redis.connect().catch((e) =>
      this.logger.warn(`RateLimit Redis connect failed (will retry): ${e.message}`),
    );
  }

  async onModuleDestroy() {
    await this.redis.quit().catch(() => undefined);
  }

  /**
   * Returns true if the provider is currently available (not rate-limited, not in cooldown).
   */
  async canUse(key: string, reqsPerWindow: number, windowSec: number): Promise<boolean> {
    try {
      // 1. Check cooldown sentinel first
      const cd = await this.redis.exists(`cd:${key}`);
      if (cd) return false;

      // 2. Check window counter
      const slot = Math.floor(Date.now() / 1000 / windowSec);
      const cnt = await this.redis.get(`cnt:${key}:${slot}`);
      return (parseInt(cnt ?? '0', 10)) < reqsPerWindow;
    } catch {
      // If Redis is down, allow the request (fail open)
      return true;
    }
  }

  /**
   * Record one usage tick for a provider. Call after a successful request.
   */
  async record(key: string, windowSec: number): Promise<void> {
    try {
      const slot = Math.floor(Date.now() / 1000 / windowSec);
      const cntKey = `cnt:${key}:${slot}`;
      const pipe = this.redis.pipeline();
      pipe.incr(cntKey);
      pipe.expire(cntKey, windowSec * 2);
      await pipe.exec();
    } catch {
      // non-fatal
    }
  }

  /**
   * Mark a provider as rate-limited (429) — sets a cooldown key so it is
   * skipped for `cooldownSec` seconds.
   */
  async markCooldown(key: string, cooldownSec: number): Promise<void> {
    try {
      await this.redis.setex(`cd:${key}`, cooldownSec, '1');
      this.logger.warn(`Provider [${key}] cooling down for ${cooldownSec}s`);
    } catch {
      // non-fatal
    }
  }

  /**
   * Returns the remaining capacity and cooldown TTL for a provider.
   * Used by the admin status endpoint.
   */
  async getStatus(
    key: string,
    reqsPerWindow: number,
    windowSec: number,
  ): Promise<{ available: boolean; used: number; remaining: number; cooldownTtl: number }> {
    try {
      const [cdTtl, cnt] = await Promise.all([
        this.redis.ttl(`cd:${key}`),
        this.redis.get(`cnt:${key}:${Math.floor(Date.now() / 1000 / windowSec)}`),
      ]);
      const used = parseInt(cnt ?? '0', 10);
      const cooldownTtl = Math.max(0, cdTtl);
      return {
        available: cooldownTtl === 0 && used < reqsPerWindow,
        used,
        remaining: Math.max(0, reqsPerWindow - used),
        cooldownTtl,
      };
    } catch {
      return { available: true, used: 0, remaining: reqsPerWindow, cooldownTtl: 0 };
    }
  }
}
