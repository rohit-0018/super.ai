import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WashTradeDetector } from './wash.trade.detector.js';
import type { RedisAdapter, Logger, AlertBus } from './wash.trade.detector.js';
import type { SecurityConfig } from '../types/config.js';
import type { PlaceOrderAction } from '../types/actions.js';
import { AgentActionType, OrderSide, OrderType } from '../types/actions.js';
import { ComplianceError, SecurityErrorCode } from '../types/errors.js';
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
    lpush: vi.fn().mockResolvedValue(1),
    lrange: vi.fn().mockResolvedValue([]),
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

describe('WashTradeDetector', () => {
  let config: SecurityConfig;
  let redis: RedisAdapter;
  let logger: Logger;
  let alertBus: AlertBus;
  let detector: WashTradeDetector;

  beforeEach(() => {
    config = makeConfig();
    redis = makeRedis();
    logger = makeLogger();
    alertBus = makeAlertBus();
    detector = new WashTradeDetector(config, logger, redis, alertBus);
  });

  it('returns not detected when no prior orders exist', async () => {
    const result = await detector.check(makeAction(), 'user-1');
    expect(result.detected).toBe(false);
    expect(result.relatedOrderId).toBeUndefined();
  });

  it('stores the order in Redis with TTL after check', async () => {
    await detector.check(makeAction(), 'user-1');

    expect(redis.lpush).toHaveBeenCalledWith(
      'wash:orders:user-1:BTC-USDT',
      expect.stringContaining('"clientOrderId":"order-aaa-111"'),
    );
    expect(redis.expire).toHaveBeenCalledWith('wash:orders:user-1:BTC-USDT', 1);
  });

  it('detects wash trade when opposite side order with similar quantity exists in window', async () => {
    const storedOrder = JSON.stringify({
      clientOrderId: 'order-bbb-222',
      instrument: 'BTC-USDT',
      side: OrderSide.SELL,
      quantity: 1.0,
      timestamp: Date.now() - 500,
    });

    vi.mocked(redis.lrange).mockResolvedValue([storedOrder]);

    const buyAction = makeAction({
      side: OrderSide.BUY,
      quantity: 1.0,
      clientOrderId: 'order-aaa-111',
    });

    await expect(detector.check(buyAction, 'user-1')).rejects.toThrow(ComplianceError);
  });

  it('throws ComplianceError with correct error code on wash trade', async () => {
    const storedOrder = JSON.stringify({
      clientOrderId: 'order-bbb-222',
      instrument: 'BTC-USDT',
      side: OrderSide.SELL,
      quantity: 1.05,
      timestamp: Date.now() - 200,
    });

    vi.mocked(redis.lrange).mockResolvedValue([storedOrder]);

    const buyAction = makeAction({
      side: OrderSide.BUY,
      quantity: 1.0,
    });

    try {
      await detector.check(buyAction, 'user-1');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ComplianceError);
      const ce = err as ComplianceError;
      expect(ce.code).toBe(SecurityErrorCode.COMPLIANCE_WASH_TRADE);
    }
  });

  it('emits WASH_TRADE_DETECTED alert with CRITICAL level', async () => {
    const storedOrder = JSON.stringify({
      clientOrderId: 'order-bbb-222',
      instrument: 'BTC-USDT',
      side: OrderSide.SELL,
      quantity: 1.0,
      timestamp: Date.now() - 100,
    });

    vi.mocked(redis.lrange).mockResolvedValue([storedOrder]);

    try {
      await detector.check(makeAction({ side: OrderSide.BUY }), 'user-1');
    } catch {
      // expected
    }

    expect(alertBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        level: RiskLevel.CRITICAL,
        type: SecurityEventType.WASH_TRADE_DETECTED,
      }),
    );
  });

  it('does not flag orders on the same side', async () => {
    const storedOrder = JSON.stringify({
      clientOrderId: 'order-bbb-222',
      instrument: 'BTC-USDT',
      side: OrderSide.BUY,
      quantity: 1.0,
      timestamp: Date.now() - 100,
    });

    vi.mocked(redis.lrange).mockResolvedValue([storedOrder]);

    const result = await detector.check(
      makeAction({ side: OrderSide.BUY }),
      'user-1',
    );
    expect(result.detected).toBe(false);
  });

  it('does not flag orders outside the detection window', async () => {
    const storedOrder = JSON.stringify({
      clientOrderId: 'order-bbb-222',
      instrument: 'BTC-USDT',
      side: OrderSide.SELL,
      quantity: 1.0,
      timestamp: Date.now() - 5000, // well outside 1000ms window
    });

    vi.mocked(redis.lrange).mockResolvedValue([storedOrder]);

    const result = await detector.check(
      makeAction({ side: OrderSide.BUY }),
      'user-1',
    );
    expect(result.detected).toBe(false);
  });

  it('does not flag when quantity difference exceeds 10% tolerance', async () => {
    const storedOrder = JSON.stringify({
      clientOrderId: 'order-bbb-222',
      instrument: 'BTC-USDT',
      side: OrderSide.SELL,
      quantity: 2.0, // 100% diff from 1.0
      timestamp: Date.now() - 100,
    });

    vi.mocked(redis.lrange).mockResolvedValue([storedOrder]);

    const result = await detector.check(
      makeAction({ side: OrderSide.BUY, quantity: 1.0 }),
      'user-1',
    );
    expect(result.detected).toBe(false);
  });

  it('flags when quantity is within 10% tolerance', async () => {
    // 1.0 vs 1.09 => diff=0.09, avg=1.045, ratio=0.0861 < 0.10
    const storedOrder = JSON.stringify({
      clientOrderId: 'order-bbb-222',
      instrument: 'BTC-USDT',
      side: OrderSide.SELL,
      quantity: 1.09,
      timestamp: Date.now() - 100,
    });

    vi.mocked(redis.lrange).mockResolvedValue([storedOrder]);

    await expect(
      detector.check(makeAction({ side: OrderSide.BUY, quantity: 1.0 }), 'user-1'),
    ).rejects.toThrow(ComplianceError);
  });

  it('logs a warning when wash trade is detected', async () => {
    const storedOrder = JSON.stringify({
      clientOrderId: 'order-bbb-222',
      instrument: 'BTC-USDT',
      side: OrderSide.SELL,
      quantity: 1.0,
      timestamp: Date.now() - 100,
    });

    vi.mocked(redis.lrange).mockResolvedValue([storedOrder]);

    try {
      await detector.check(makeAction({ side: OrderSide.BUY }), 'user-1');
    } catch {
      // expected
    }

    expect(logger.warn).toHaveBeenCalledWith(
      'Wash trade detected',
      expect.objectContaining({
        userId: 'user-1',
        instrument: 'BTC-USDT',
      }),
    );
  });

  it('uses correct Redis key based on userId and instrument', async () => {
    await detector.check(
      makeAction({ instrument: 'ETH-USDT' }),
      'user-42',
    );

    expect(redis.lrange).toHaveBeenCalledWith(
      'wash:orders:user-42:ETH-USDT',
      0,
      -1,
    );
  });
});
