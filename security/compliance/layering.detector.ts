import { randomUUID } from 'node:crypto';
import type { SecurityConfig } from '../types/config.js';
import { SecurityEventType, RiskLevel } from '../types/events.js';
import type { PlaceOrderAction } from '../types/actions.js';

// ─── Interfaces ─────────────────────────────────────────────────────────────

export interface RedisAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  setex(key: string, ttlSeconds: number, value: string): Promise<void>;
  del(key: string): Promise<void>;
  incr(key: string): Promise<number>;
  expire(key: string, ttlSeconds: number): Promise<void>;
}

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface AlertBus {
  emit(alert: {
    level: string;
    type: string;
    message: string;
    correlationId: string;
    metadata: Record<string, unknown>;
  }): void;
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface LayeringCheckResult {
  suspicious: boolean;
  cancelRatio: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const KEY_PREFIX = 'layering:';

function orderCountKey(userId: string, instrument: string): string {
  return `${KEY_PREFIX}orders:${userId}:${instrument}`;
}

function cancelCountKey(userId: string, instrument: string): string {
  return `${KEY_PREFIX}cancels:${userId}:${instrument}`;
}

// ─── LayeringDetector ───────────────────────────────────────────────────────

export class LayeringDetector {
  private readonly config: SecurityConfig;
  private readonly logger: Logger;
  private readonly redis: RedisAdapter;
  private readonly alertBus: AlertBus;

  constructor(
    config: SecurityConfig,
    logger: Logger,
    redis: RedisAdapter,
    alertBus: AlertBus,
  ) {
    this.config = config;
    this.logger = logger;
    this.redis = redis;
    this.alertBus = alertBus;
  }

  public async recordOrder(
    action: PlaceOrderAction,
    userId: string,
  ): Promise<void> {
    const key = orderCountKey(userId, action.instrument);
    const ttlSeconds = Math.ceil(this.config.layeringDetectionWindowMs / 1000);

    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, ttlSeconds);
    }
  }

  public async recordCancellation(
    _clientOrderId: string,
    userId: string,
    instrument: string,
  ): Promise<void> {
    const key = cancelCountKey(userId, instrument);
    const ttlSeconds = Math.ceil(this.config.layeringDetectionWindowMs / 1000);

    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, ttlSeconds);
    }
  }

  public async check(
    userId: string,
    instrument: string,
    strategyId: string,
  ): Promise<LayeringCheckResult> {
    const orderKey = orderCountKey(userId, instrument);
    const cancelKey = cancelCountKey(userId, instrument);

    const [rawOrderCount, rawCancelCount] = await Promise.all([
      this.redis.get(orderKey),
      this.redis.get(cancelKey),
    ]);

    const orderCount = rawOrderCount !== null ? parseInt(rawOrderCount, 10) : 0;
    const cancelCount = rawCancelCount !== null ? parseInt(rawCancelCount, 10) : 0;

    const cancelRatio = orderCount > 0 ? cancelCount / orderCount : 0;

    if (cancelRatio > this.config.layeringCancelRatioThreshold) {
      const correlationId = randomUUID();

      this.logger.warn('Layering/spoofing pattern detected', {
        userId,
        instrument,
        strategyId,
        cancelCount,
        orderCount,
        cancelRatio,
        correlationId,
      });

      this.alertBus.emit({
        level: RiskLevel.HIGH,
        type: SecurityEventType.LAYERING_DETECTED,
        message: `Layering detected for ${instrument}: cancel ratio ${cancelRatio.toFixed(2)}`,
        correlationId,
        metadata: {
          instrument,
          strategyId,
          cancelCount,
          orderCount,
          cancelRatio,
          windowMs: this.config.layeringDetectionWindowMs,
        },
      });

      return { suspicious: true, cancelRatio };
    }

    return { suspicious: false, cancelRatio };
  }
}
