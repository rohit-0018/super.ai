import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LayeringDetector } from './layering.detector.js';
import type { RedisAdapter, Logger, AlertBus } from './layering.detector.js';
import type { SecurityConfig } from '../types/config.js';
import type { PlaceOrderAction } from '../types/actions.js';
import { AgentActionType, OrderSide, OrderType } from '../types/actions.js';
import { SecurityEventType, RiskLevel } from '../types/events.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<SecurityConfig> = {}): SecurityConfig {
  return {
    washTradeDetectionWindowMs: 1000,
    layeringDetectionWindowMs: 5000,
    layeringCancelRatioThreshold: 0.8,
    ...overrides,
  } as SecurityConfig;
}

function makeAction(overrides: Partial<PlaceOrderAction> = {}): PlaceOrderAction {
  return {
    type: AgentActionType.PlaceOrder,
    instrument: 'BTC-USDT',
    side: OrderSide.BUY,
    orderType: OrderType.LIMIT,
    quantity: 1.0,
    price: 50000,
    strategyId: 'strat-1',
    clientOrderId: 'order-aaa-111',
    ...overrides,
  };
}

function makeRedis(): RedisAdapter {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    setex: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(undefined),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(undefined),
  };
}

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeAlertBus(): AlertBus {
  return {
    emit: vi.fn(),
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('LayeringDetector', () => {
  let config: SecurityConfig;
  let redis: RedisAdapter;
  let logger: Logger;
  let alertBus: AlertBus;
  let detector: LayeringDetector;

  beforeEach(() => {
    config = makeConfig();
    redis = makeRedis();
    logger = makeLogger();
    alertBus = makeAlertBus();
    detector = new LayeringDetector(config, logger, redis, alertBus);
  });

  describe('recordOrder', () => {
    it('increments the order count in Redis', async () => {
      await detector.recordOrder(makeAction(), 'user-1');

      expect(redis.incr).toHaveBeenCalledWith('layering:orders:user-1:BTC-USDT');
    });

    it('sets TTL on first order', async () => {
      vi.mocked(redis.incr).mockResolvedValue(1);

      await detector.recordOrder(makeAction(), 'user-1');

      expect(redis.expire).toHaveBeenCalledWith(
        'layering:orders:user-1:BTC-USDT',
        5,
      );
    });

    it('does not reset TTL on subsequent orders', async () => {
      vi.mocked(redis.incr).mockResolvedValue(3);

      await detector.recordOrder(makeAction(), 'user-1');

      expect(redis.expire).not.toHaveBeenCalled();
    });
  });

  describe('recordCancellation', () => {
    it('increments the cancel count in Redis', async () => {
      await detector.recordCancellation('order-1', 'user-1', 'BTC-USDT');

      expect(redis.incr).toHaveBeenCalledWith('layering:cancels:user-1:BTC-USDT');
    });

    it('sets TTL on first cancellation', async () => {
      vi.mocked(redis.incr).mockResolvedValue(1);

      await detector.recordCancellation('order-1', 'user-1', 'BTC-USDT');

      expect(redis.expire).toHaveBeenCalledWith(
        'layering:cancels:user-1:BTC-USDT',
        5,
      );
    });
  });

  describe('check', () => {
    it('returns not suspicious when no orders or cancels exist', async () => {
      const result = await detector.check('user-1', 'BTC-USDT', 'strat-1');

      expect(result.suspicious).toBe(false);
      expect(result.cancelRatio).toBe(0);
    });

    it('returns not suspicious when cancel ratio is below threshold', async () => {
      vi.mocked(redis.get)
        .mockResolvedValueOnce('10') // orderCount
        .mockResolvedValueOnce('5');  // cancelCount => ratio 0.5

      const result = await detector.check('user-1', 'BTC-USDT', 'strat-1');

      expect(result.suspicious).toBe(false);
      expect(result.cancelRatio).toBe(0.5);
    });

    it('returns suspicious when cancel ratio exceeds threshold', async () => {
      vi.mocked(redis.get)
        .mockResolvedValueOnce('10') // orderCount
        .mockResolvedValueOnce('9');  // cancelCount => ratio 0.9

      const result = await detector.check('user-1', 'BTC-USDT', 'strat-1');

      expect(result.suspicious).toBe(true);
      expect(result.cancelRatio).toBe(0.9);
    });

    it('returns not suspicious when cancel ratio equals threshold exactly', async () => {
      vi.mocked(redis.get)
        .mockResolvedValueOnce('10') // orderCount
        .mockResolvedValueOnce('8');  // cancelCount => ratio 0.8

      const result = await detector.check('user-1', 'BTC-USDT', 'strat-1');

      expect(result.suspicious).toBe(false);
      expect(result.cancelRatio).toBe(0.8);
    });

    it('emits LAYERING_DETECTED alert when suspicious', async () => {
      vi.mocked(redis.get)
        .mockResolvedValueOnce('10')
        .mockResolvedValueOnce('9');

      await detector.check('user-1', 'BTC-USDT', 'strat-1');

      expect(alertBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          level: RiskLevel.HIGH,
          type: SecurityEventType.LAYERING_DETECTED,
        }),
      );
    });

    it('logs warning when suspicious', async () => {
      vi.mocked(redis.get)
        .mockResolvedValueOnce('10')
        .mockResolvedValueOnce('9');

      await detector.check('user-1', 'BTC-USDT', 'strat-1');

      expect(logger.warn).toHaveBeenCalledWith(
        'Layering/spoofing pattern detected',
        expect.objectContaining({
          userId: 'user-1',
          instrument: 'BTC-USDT',
          cancelRatio: 0.9,
        }),
      );
    });

    it('does not emit alert when not suspicious', async () => {
      vi.mocked(redis.get)
        .mockResolvedValueOnce('10')
        .mockResolvedValueOnce('2');

      await detector.check('user-1', 'BTC-USDT', 'strat-1');

      expect(alertBus.emit).not.toHaveBeenCalled();
    });

    it('handles zero orders gracefully (ratio = 0)', async () => {
      vi.mocked(redis.get)
        .mockResolvedValueOnce('0')
        .mockResolvedValueOnce('5');

      const result = await detector.check('user-1', 'BTC-USDT', 'strat-1');

      expect(result.suspicious).toBe(false);
      expect(result.cancelRatio).toBe(0);
    });

    it('reads from correct Redis keys', async () => {
      await detector.check('user-42', 'ETH-USDT', 'strat-2');

      expect(redis.get).toHaveBeenCalledWith('layering:orders:user-42:ETH-USDT');
      expect(redis.get).toHaveBeenCalledWith('layering:cancels:user-42:ETH-USDT');
    });

    it('includes metadata in alert with window and counts', async () => {
      vi.mocked(redis.get)
        .mockResolvedValueOnce('5')
        .mockResolvedValueOnce('5'); // ratio = 1.0

      await detector.check('user-1', 'BTC-USDT', 'strat-1');

      expect(alertBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            instrument: 'BTC-USDT',
            strategyId: 'strat-1',
            cancelCount: 5,
            orderCount: 5,
            cancelRatio: 1.0,
            windowMs: 5000,
          }),
        }),
      );
    });
  });
});
