import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DuplicateDetector,
  type Logger,
  type EventEmitter,
  type RedisAdapter,
  type DuplicateDetectorConfig,
} from './duplicate.detector.js';
import { AgentActionType, OrderSide, OrderType } from '../types/actions.js';
import type { PlaceOrderAction, AgentAction } from '../types/actions.js';
import { SecurityEventType } from '../types/events.js';

// ─── Test helpers ───────────────────────────────────────────────────────────

function createLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createEmitter(): EventEmitter {
  return {
    emit: vi.fn(),
  };
}

function createRedisAdapter(store: Map<string, string> = new Map()): RedisAdapter {
  return {
    get: vi.fn(async (key: string): Promise<string | null> => {
      return store.get(key) ?? null;
    }),
    set: vi.fn(async (key: string, value: string, _ttlSeconds?: number): Promise<void> => {
      store.set(key, value);
    }),
  };
}

function validPlaceOrder(overrides: Partial<PlaceOrderAction> = {}): PlaceOrderAction {
  return {
    type: AgentActionType.PlaceOrder,
    instrument: 'BTC-USDT',
    side: OrderSide.BUY,
    orderType: OrderType.LIMIT,
    quantity: 1.5,
    price: 50000,
    strategyId: 'strat-1',
    clientOrderId: '550e8400-e29b-41d4-a716-446655440000',
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('DuplicateDetector', () => {
  let logger: Logger;
  let emitter: EventEmitter;

  beforeEach(() => {
    logger = createLogger();
    emitter = createEmitter();
  });

  describe('PlaceOrder dedup', () => {
    it('returns isDuplicate: false for a new order', async () => {
      const redis = createRedisAdapter();
      const detector = new DuplicateDetector({
        logger,
        redisAdapter: redis,
        emitter,
      });

      const result = await detector.check(validPlaceOrder());
      expect(result.isDuplicate).toBe(false);
      expect(result.originalOrderId).toBeUndefined();
    });

    it('stores the dedup key in Redis', async () => {
      const redis = createRedisAdapter();
      const detector = new DuplicateDetector({
        logger,
        redisAdapter: redis,
        emitter,
      });

      await detector.check(validPlaceOrder());
      expect(redis.set).toHaveBeenCalledTimes(1);
      expect(redis.set).toHaveBeenCalledWith(
        expect.stringContaining('security:dedup:'),
        '550e8400-e29b-41d4-a716-446655440000',
        60, // default TTL
      );
    });

    it('returns isDuplicate: true when same order is checked twice', async () => {
      const store = new Map<string, string>();
      const redis = createRedisAdapter(store);
      const detector = new DuplicateDetector({
        logger,
        redisAdapter: redis,
        emitter,
      });

      const order = validPlaceOrder();
      const first = await detector.check(order);
      expect(first.isDuplicate).toBe(false);

      // Second check with different clientOrderId but same dedup key
      const order2 = validPlaceOrder({
        clientOrderId: '660e8400-e29b-41d4-a716-446655440001',
      });
      const second = await detector.check(order2);
      expect(second.isDuplicate).toBe(true);
      expect(second.originalOrderId).toBe('550e8400-e29b-41d4-a716-446655440000');
    });

    it('emits DUPLICATE_ORDER_DETECTED when duplicate found', async () => {
      const store = new Map<string, string>();
      const redis = createRedisAdapter(store);
      const detector = new DuplicateDetector({
        logger,
        redisAdapter: redis,
        emitter,
      });

      const order = validPlaceOrder();
      await detector.check(order);

      const order2 = validPlaceOrder({
        clientOrderId: '660e8400-e29b-41d4-a716-446655440001',
      });
      await detector.check(order2);

      expect(emitter.emit).toHaveBeenCalledWith(
        SecurityEventType.DUPLICATE_ORDER_DETECTED,
        expect.objectContaining({
          clientOrderId: '660e8400-e29b-41d4-a716-446655440001',
          instrument: 'BTC-USDT',
          strategyId: 'strat-1',
          existingOrderId: '550e8400-e29b-41d4-a716-446655440000',
        }),
      );
    });

    it('does not emit events for non-duplicate orders', async () => {
      const redis = createRedisAdapter();
      const detector = new DuplicateDetector({
        logger,
        redisAdapter: redis,
        emitter,
      });

      await detector.check(validPlaceOrder());
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('uses custom TTL from config', async () => {
      const redis = createRedisAdapter();
      const detector = new DuplicateDetector({
        config: { dedupWindowSeconds: 120 },
        logger,
        redisAdapter: redis,
        emitter,
      });

      await detector.check(validPlaceOrder());
      expect(redis.set).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        120,
      );
    });

    it('uses custom Redis key prefix', async () => {
      const redis = createRedisAdapter();
      const detector = new DuplicateDetector({
        config: { redisKeyPrefix: 'custom:prefix:' },
        logger,
        redisAdapter: redis,
        emitter,
      });

      await detector.check(validPlaceOrder());
      expect(redis.set).toHaveBeenCalledWith(
        expect.stringContaining('custom:prefix:'),
        expect.any(String),
        expect.any(Number),
      );
    });
  });

  describe('dedup key computation', () => {
    it('produces different keys for different instruments', () => {
      const redis = createRedisAdapter();
      const detector = new DuplicateDetector({
        logger,
        redisAdapter: redis,
        emitter,
      });

      const order1 = validPlaceOrder({ instrument: 'BTC-USDT' });
      const order2 = validPlaceOrder({ instrument: 'ETH-USDT' });

      expect(detector.computeDedupKey(order1)).not.toBe(detector.computeDedupKey(order2));
    });

    it('produces different keys for different sides', () => {
      const redis = createRedisAdapter();
      const detector = new DuplicateDetector({
        logger,
        redisAdapter: redis,
        emitter,
      });

      const order1 = validPlaceOrder({ side: OrderSide.BUY });
      const order2 = validPlaceOrder({ side: OrderSide.SELL });

      expect(detector.computeDedupKey(order1)).not.toBe(detector.computeDedupKey(order2));
    });

    it('produces different keys for different quantities', () => {
      const redis = createRedisAdapter();
      const detector = new DuplicateDetector({
        logger,
        redisAdapter: redis,
        emitter,
      });

      const order1 = validPlaceOrder({ quantity: 1.5 });
      const order2 = validPlaceOrder({ quantity: 2.0 });

      expect(detector.computeDedupKey(order1)).not.toBe(detector.computeDedupKey(order2));
    });

    it('produces same key for same parameters regardless of clientOrderId', () => {
      const redis = createRedisAdapter();
      const detector = new DuplicateDetector({
        logger,
        redisAdapter: redis,
        emitter,
      });

      const order1 = validPlaceOrder({
        clientOrderId: '550e8400-e29b-41d4-a716-446655440000',
      });
      const order2 = validPlaceOrder({
        clientOrderId: '660e8400-e29b-41d4-a716-446655440001',
      });

      expect(detector.computeDedupKey(order1)).toBe(detector.computeDedupKey(order2));
    });

    it('rounds quantity to 2 decimal places', () => {
      const redis = createRedisAdapter();
      const detector = new DuplicateDetector({
        logger,
        redisAdapter: redis,
        emitter,
      });

      const order1 = validPlaceOrder({ quantity: 1.501 });
      const order2 = validPlaceOrder({ quantity: 1.504 });

      // Both round to 1.50
      expect(detector.computeDedupKey(order1)).toBe(detector.computeDedupKey(order2));
    });

    it('handles MARKET orders (no price) in dedup key', () => {
      const redis = createRedisAdapter();
      const detector = new DuplicateDetector({
        logger,
        redisAdapter: redis,
        emitter,
      });

      const order = validPlaceOrder({
        orderType: OrderType.MARKET,
        price: undefined,
      });

      const key = detector.computeDedupKey(order);
      expect(key).toBeTruthy();
      expect(typeof key).toBe('string');
      expect(key.length).toBe(64); // SHA-256 hex
    });
  });

  describe('non-PlaceOrder actions', () => {
    it('returns isDuplicate: false for CancelOrder', async () => {
      const redis = createRedisAdapter();
      const detector = new DuplicateDetector({
        logger,
        redisAdapter: redis,
        emitter,
      });

      const action: AgentAction = {
        type: AgentActionType.CancelOrder,
        clientOrderId: '550e8400-e29b-41d4-a716-446655440000',
        instrument: 'BTC-USDT',
        strategyId: 'strat-1',
      };

      const result = await detector.check(action);
      expect(result.isDuplicate).toBe(false);
      expect(redis.get).not.toHaveBeenCalled();
    });

    it('returns isDuplicate: false for ModifyOrder', async () => {
      const redis = createRedisAdapter();
      const detector = new DuplicateDetector({
        logger,
        redisAdapter: redis,
        emitter,
      });

      const action: AgentAction = {
        type: AgentActionType.ModifyOrder,
        clientOrderId: '550e8400-e29b-41d4-a716-446655440000',
        instrument: 'BTC-USDT',
        newQuantity: 2,
        strategyId: 'strat-1',
      };

      const result = await detector.check(action);
      expect(result.isDuplicate).toBe(false);
    });

    it('returns isDuplicate: false for NoAction', async () => {
      const redis = createRedisAdapter();
      const detector = new DuplicateDetector({
        logger,
        redisAdapter: redis,
        emitter,
      });

      const action: AgentAction = {
        type: AgentActionType.NoAction,
        reason: 'No signal',
      };

      const result = await detector.check(action);
      expect(result.isDuplicate).toBe(false);
    });
  });
});
