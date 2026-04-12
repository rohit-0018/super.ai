import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { SecurityEventType, RiskLevel } from '../types/events.js';

// ─── Interfaces ────────────────────────────────────────────────────────────

export interface ExchangeQuotaRedisAdapter {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<void>;
  get(key: string): Promise<string | null>;
}

export interface ExchangeQuotaLogger {
  log(event: {
    eventType: SecurityEventType;
    timestamp: string;
    correlationId: string;
    riskLevel: RiskLevel;
    payload: Record<string, unknown>;
  }): void;
}

// ─── Types ─────────────────────────────────────────────────────────────────

export const ExchangeQuotaConfigSchema = z.object({
  exchangeId: z.string().min(1),
  ordersPerSecond: z.number().int().positive(),
  ordersPerDay: z.number().int().positive(),
  warningThresholdPercent: z.number().min(0).max(100),
});

export type ExchangeQuotaConfig = z.infer<typeof ExchangeQuotaConfigSchema>;

export interface QuotaCheckResult {
  allowed: boolean;
  secondsRemaining: number;
  dailyRemaining: number;
  warning: boolean;
}

// ─── Constants ─────────────────────────────────────────────────────────────

const PER_SECOND_PREFIX = 'exchange:quota:sec:';
const PER_DAY_PREFIX = 'exchange:quota:day:';
const SECONDS_IN_DAY = 86400;

// ─── ExchangeQuotaAdapter ──────────────────────────────────────────────────

export class ExchangeQuotaAdapter {
  private readonly configs: ReadonlyMap<string, ExchangeQuotaConfig>;
  private readonly redis: ExchangeQuotaRedisAdapter;
  private readonly logger: ExchangeQuotaLogger;

  constructor(
    configs: ReadonlyMap<string, ExchangeQuotaConfig>,
    redis: ExchangeQuotaRedisAdapter,
    logger: ExchangeQuotaLogger,
  ) {
    this.configs = configs;
    this.redis = redis;
    this.logger = logger;
  }

  public async recordOrderSent(exchangeId: string): Promise<void> {
    const config = this.getConfig(exchangeId);

    const secKey = `${PER_SECOND_PREFIX}${exchangeId}`;
    const dayKey = `${PER_DAY_PREFIX}${exchangeId}`;

    // Increment per-second counter and set 1s TTL
    const secCount = await this.redis.incr(secKey);
    if (secCount === 1) {
      await this.redis.expire(secKey, 1);
    }

    // Increment per-day counter and set 86400s TTL
    const dayCount = await this.redis.incr(dayKey);
    if (dayCount === 1) {
      await this.redis.expire(dayKey, SECONDS_IN_DAY);
    }

    // Check if warning threshold has been crossed for daily quota
    const usedPercent = (dayCount / config.ordersPerDay) * 100;
    if (usedPercent >= config.warningThresholdPercent) {
      const now = Date.now();
      this.logger.log({
        eventType: SecurityEventType.EXCHANGE_QUOTA_WARNING,
        timestamp: new Date(now).toISOString(),
        correlationId: randomUUID(),
        riskLevel: RiskLevel.MEDIUM,
        payload: {
          exchange: exchangeId,
          usedPercent,
          remainingRequests: Math.max(0, config.ordersPerDay - dayCount),
          resetAtMs: now + SECONDS_IN_DAY * 1000,
        },
      });
    }
  }

  public async canSendOrder(exchangeId: string): Promise<QuotaCheckResult> {
    const config = this.getConfig(exchangeId);

    const secKey = `${PER_SECOND_PREFIX}${exchangeId}`;
    const dayKey = `${PER_DAY_PREFIX}${exchangeId}`;

    // Read current counters
    const secRaw = await this.redis.get(secKey);
    const dayRaw = await this.redis.get(dayKey);

    const secCount = secRaw !== null ? this.parseCount(secRaw) : 0;
    const dayCount = dayRaw !== null ? this.parseCount(dayRaw) : 0;

    const secondsRemaining = Math.max(0, config.ordersPerSecond - secCount);
    const dailyRemaining = Math.max(0, config.ordersPerDay - dayCount);

    const allowed = secondsRemaining > 0 && dailyRemaining > 0;

    const usedPercent = (dayCount / config.ordersPerDay) * 100;
    const warning = usedPercent >= config.warningThresholdPercent;

    return {
      allowed,
      secondsRemaining,
      dailyRemaining,
      warning,
    };
  }

  private getConfig(exchangeId: string): ExchangeQuotaConfig {
    const config = this.configs.get(exchangeId);
    if (!config) {
      throw new Error(`No quota config found for exchange "${exchangeId}"`);
    }
    return config;
  }

  private parseCount(raw: string): number {
    const CountSchema = z.coerce.number().int().nonnegative();
    return CountSchema.parse(raw);
  }
}
