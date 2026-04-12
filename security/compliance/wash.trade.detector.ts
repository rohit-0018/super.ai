import { randomUUID } from 'node:crypto';
import type { SecurityConfig } from '../types/config.js';
import { SecurityEventType, RiskLevel } from '../types/events.js';
import { OrderSide } from '../types/actions.js';
import type { PlaceOrderAction } from '../types/actions.js';
import { ComplianceError, SecurityErrorCode } from '../types/errors.js';

// ─── Interfaces ─────────────────────────────────────────────────────────────

export interface RedisAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  setex(key: string, ttlSeconds: number, value: string): Promise<void>;
  del(key: string): Promise<void>;
  lpush(key: string, value: string): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
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

export interface WashTradeCheckResult {
  detected: boolean;
  relatedOrderId?: string;
}

interface StoredOrder {
  clientOrderId: string;
  instrument: string;
  side: string;
  quantity: number;
  timestamp: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const KEY_PREFIX = 'wash:orders:';
const QUANTITY_TOLERANCE = 0.1;

function orderListKey(userId: string, instrument: string): string {
  return `${KEY_PREFIX}${userId}:${instrument}`;
}

// ─── WashTradeDetector ──────────────────────────────────────────────────────

export class WashTradeDetector {
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

  public async check(
    action: PlaceOrderAction,
    userId: string,
  ): Promise<WashTradeCheckResult> {
    const windowMs = this.config.washTradeDetectionWindowMs;
    const key = orderListKey(userId, action.instrument);
    const now = Date.now();

    // Fetch recent orders from Redis
    const rawOrders = await this.redis.lrange(key, 0, -1);

    const oppositeSide =
      action.side === OrderSide.BUY ? OrderSide.SELL : OrderSide.BUY;

    for (const raw of rawOrders) {
      const stored: StoredOrder = JSON.parse(raw) as StoredOrder;

      // Skip orders outside the detection window
      if (now - stored.timestamp > windowMs) {
        continue;
      }

      // Check for opposite side with quantity within 10% tolerance
      if (stored.side === oppositeSide) {
        const diff = Math.abs(stored.quantity - action.quantity);
        const avg = (stored.quantity + action.quantity) / 2;
        const ratio = avg > 0 ? diff / avg : 0;

        if (ratio <= QUANTITY_TOLERANCE) {
          const correlationId = randomUUID();

          this.logger.warn('Wash trade detected', {
            userId,
            instrument: action.instrument,
            currentOrderId: action.clientOrderId,
            relatedOrderId: stored.clientOrderId,
            correlationId,
          });

          this.alertBus.emit({
            level: RiskLevel.CRITICAL,
            type: SecurityEventType.WASH_TRADE_DETECTED,
            message: `Wash trade detected for ${action.instrument}`,
            correlationId,
            metadata: {
              instrument: action.instrument,
              buyOrderId:
                action.side === OrderSide.BUY
                  ? action.clientOrderId
                  : stored.clientOrderId,
              sellOrderId:
                action.side === OrderSide.SELL
                  ? action.clientOrderId
                  : stored.clientOrderId,
              strategyId: action.strategyId,
              windowMs,
            },
          });

          throw new ComplianceError(
            `Wash trade detected for ${action.instrument}: order ${action.clientOrderId} matches ${stored.clientOrderId}`,
            correlationId,
            SecurityErrorCode.COMPLIANCE_WASH_TRADE,
            {
              instrument: action.instrument,
              currentOrderId: action.clientOrderId,
              relatedOrderId: stored.clientOrderId,
              userId,
            },
          );
        }
      }
    }

    // Store current order with TTL
    const storedOrder: StoredOrder = {
      clientOrderId: action.clientOrderId,
      instrument: action.instrument,
      side: action.side,
      quantity: action.quantity,
      timestamp: now,
    };

    await this.redis.lpush(key, JSON.stringify(storedOrder));
    const ttlSeconds = Math.ceil(windowMs / 1000);
    await this.redis.expire(key, ttlSeconds);

    return { detected: false };
  }
}
