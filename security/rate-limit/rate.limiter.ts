import { randomUUID } from 'node:crypto';
import { SecurityEventType, RiskLevel } from '../types/events.js';

// ─── Interfaces ────────────────────────────────────────────────────────────

export interface RateLimiterRedisAdapter {
  zadd(key: string, score: number, member: string): Promise<number>;
  zremrangebyscore(key: string, min: number, max: number): Promise<number>;
  zcard(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<void>;
}

export interface RateLimiterLogger {
  log(event: {
    eventType: SecurityEventType;
    timestamp: string;
    correlationId: string;
    riskLevel: RiskLevel;
    payload: Record<string, unknown>;
  }): void;
}

// ─── Types ─────────────────────────────────────────────────────────────────

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
}

export interface RateLimitIdentifier {
  key: string;
  limit: number;
  windowMs: number;
}

// ─── RateLimiter ───────────────────────────────────────────────────────────

export class RateLimiter {
  private readonly redis: RateLimiterRedisAdapter;
  private readonly logger: RateLimiterLogger;

  constructor(redis: RateLimiterRedisAdapter, logger: RateLimiterLogger) {
    this.redis = redis;
    this.logger = logger;
  }

  public async check(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    const windowStart = now - windowMs;
    const resetAt = new Date(now + windowMs);

    // Remove entries older than the sliding window
    await this.redis.zremrangebyscore(key, 0, windowStart);

    // Count entries remaining in the window
    const currentCount = await this.redis.zcard(key);

    if (currentCount >= limit) {
      // Breached — emit event
      this.logger.log({
        eventType: SecurityEventType.RATE_LIMIT_BREACHED,
        timestamp: new Date(now).toISOString(),
        correlationId: randomUUID(),
        riskLevel: RiskLevel.MEDIUM,
        payload: {
          level: 'user' as const,
          identifier: key,
          requestCount: currentCount,
          limit,
          windowMs,
        },
      });

      return {
        allowed: false,
        remaining: 0,
        resetAt,
      };
    }

    // Under limit — add new entry with unique member and timestamp score
    const member = randomUUID();
    await this.redis.zadd(key, now, member);

    // Set a TTL on the sorted set equal to the window so it auto-expires
    const ttlSeconds = Math.ceil(windowMs / 1000);
    await this.redis.expire(key, ttlSeconds);

    return {
      allowed: true,
      remaining: limit - currentCount - 1,
      resetAt,
    };
  }

  public async checkAll(identifiers: RateLimitIdentifier[]): Promise<RateLimitResult[]> {
    const results: RateLimitResult[] = [];
    for (const identifier of identifiers) {
      const result = await this.check(identifier.key, identifier.limit, identifier.windowMs);
      results.push(result);
    }
    return results;
  }
}
