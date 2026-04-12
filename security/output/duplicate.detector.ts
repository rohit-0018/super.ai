// ─── Duplicate Detector ─────────────────────────────────────────────────────

import { createHash } from 'node:crypto';
import {
  AgentActionType,
  type AgentAction,
  type PlaceOrderAction,
} from '../types/actions.js';
import { SecurityEventType } from '../types/events.js';

// ─── Minimal interfaces for dependency injection ────────────────────────────

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface EventEmitter {
  emit(event: SecurityEventType, payload: Record<string, unknown>): void;
}

export interface RedisAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
}

// ─── Configuration ──────────────────────────────────────────────────────────

export interface DuplicateDetectorConfig {
  /** TTL in seconds for the dedup window. */
  readonly dedupWindowSeconds: number;
  /** Redis key prefix for dedup entries. */
  readonly redisKeyPrefix: string;
}

const DEFAULT_CONFIG: DuplicateDetectorConfig = {
  dedupWindowSeconds: 60,
  redisKeyPrefix: 'security:dedup:',
};

// ─── Result type ────────────────────────────────────────────────────────────

export interface DuplicateCheckResult {
  readonly isDuplicate: boolean;
  readonly originalOrderId?: string;
}

// ─── DuplicateDetector class ────────────────────────────────────────────────

export class DuplicateDetector {
  private readonly config: DuplicateDetectorConfig;
  private readonly logger: Logger;
  private readonly redis: RedisAdapter;
  private readonly emitter: EventEmitter | undefined;

  constructor(deps: {
    config?: Partial<DuplicateDetectorConfig>;
    logger: Logger;
    redisAdapter: RedisAdapter;
    emitter?: EventEmitter;
  }) {
    this.config = { ...DEFAULT_CONFIG, ...deps.config };
    this.logger = deps.logger;
    this.redis = deps.redisAdapter;
    this.emitter = deps.emitter;
  }

  /**
   * Check if the given action is a duplicate of a recently-seen order.
   * Only PlaceOrder actions are checked; all others return isDuplicate: false.
   */
  public async check(action: AgentAction): Promise<DuplicateCheckResult> {
    if (action.type !== AgentActionType.PlaceOrder) {
      return { isDuplicate: false };
    }

    const placeOrder = action;
    const dedupKey = this.computeDedupKey(placeOrder);
    const redisKey = `${this.config.redisKeyPrefix}${dedupKey}`;

    const existing = await this.redis.get(redisKey);

    if (existing !== null) {
      this.logger.warn('Duplicate order detected', {
        instrument: placeOrder.instrument,
        clientOrderId: placeOrder.clientOrderId,
        originalOrderId: existing,
        dedupKey,
      });

      this.emitter?.emit(SecurityEventType.DUPLICATE_ORDER_DETECTED, {
        clientOrderId: placeOrder.clientOrderId,
        instrument: placeOrder.instrument,
        strategyId: placeOrder.strategyId,
        existingOrderId: existing,
      });

      return {
        isDuplicate: true,
        originalOrderId: existing,
      };
    }

    // Store the order for the dedup window
    await this.redis.set(
      redisKey,
      placeOrder.clientOrderId,
      this.config.dedupWindowSeconds,
    );

    this.logger.info('Order dedup key stored', {
      instrument: placeOrder.instrument,
      clientOrderId: placeOrder.clientOrderId,
      dedupKey,
      ttlSeconds: this.config.dedupWindowSeconds,
    });

    return { isDuplicate: false };
  }

  // ─── Dedup key computation ──────────────────────────────────────────────

  /**
   * Compute SHA-256 dedup key from instrument + side + orderType + quantity (2dp) + price (nearest tick).
   */
  public computeDedupKey(order: PlaceOrderAction): string {
    const quantityRounded = order.quantity.toFixed(2);
    const priceRounded = order.price !== undefined ? order.price.toFixed(2) : 'MARKET';

    const components = [
      order.instrument,
      order.side,
      order.orderType,
      quantityRounded,
      priceRounded,
    ].join('|');

    return createHash('sha256').update(components).digest('hex');
  }
}
