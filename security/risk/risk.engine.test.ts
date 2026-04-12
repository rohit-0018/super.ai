import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RiskEngine } from './risk.engine.js';
import type { RiskContext, RiskEvaluation } from './risk.engine.js';
import { CircuitBreaker } from './circuit.breaker.js';
import type { RedisAdapter, Logger, AlertBus } from './circuit.breaker.js';
import { KillSwitch } from './kill.switch.js';
import { PositionLimitsChecker } from './position.limits.js';
import type { LimitCheckResult } from './position.limits.js';
import { LossMonitor } from './loss.monitor.js';
import type { SecurityConfig } from '../types/config.js';
import type { AgentAction, PlaceOrderAction } from '../types/actions.js';
import { AgentActionType, OrderSide, OrderType } from '../types/actions.js';
import { RiskLevel, SecurityEventType } from '../types/events.js';
import type { PortfolioSnapshot } from '../types/risk.js';

// ─── Mock factories ─────────────────────────────────────────────────────────

function createMockRedis(): RedisAdapter {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    setex: vi.fn(async (_k: string, _t: number, _v: string) => undefined),
    del: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    incr: vi.fn(async () => 1),
    expire: vi.fn(async () => undefined),
    ttl: vi.fn(async () => -1),
  };
}

function createMockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function createMockAlertBus(): AlertBus {
  return { emit: vi.fn() };
}

function createConfig(overrides?: Partial<SecurityConfig>): SecurityConfig {
  return {
    adminUserId: 'admin-001',
    sessionDrawdownKillSwitchPercent: 10,
    positionLimitsPerInstrument: { 'BTC-USDT': 10 },
    portfolioNotionalLimit: 1_000_000,
    velocityCircuitBreakerOrderCount: 50,
    velocityCircuitBreakerWindowSeconds: 60,
    errorRateCircuitBreakerConsecutiveRejectionCount: 5,
    ...overrides,
  } as SecurityConfig;
}

function makePortfolio(): PortfolioSnapshot {
  return {
    positions: [
      {
        instrument: 'BTC-USDT',
        quantity: 2,
        averageEntryPrice: 50_000,
        currentPrice: 50_000,
        unrealizedPnl: 0,
        notionalValue: 100_000,
      },
    ],
    totalNotional: 100_000,
    totalUnrealizedPnl: 0,
    drawdownFromHighWatermarkPercent: 0,
  };
}

function makeContext(overrides?: Partial<RiskContext>): RiskContext {
  return {
    userId: 'user-1',
    strategyId: 'strat-1',
    portfolio: makePortfolio(),
    sessionId: 'session-1',
    ...overrides,
  };
}

function makePlaceOrder(overrides?: Partial<PlaceOrderAction>): PlaceOrderAction {
  return {
    type: AgentActionType.PlaceOrder,
    instrument: 'BTC-USDT',
    side: OrderSide.BUY,
    orderType: OrderType.LIMIT,
    quantity: 1,
    price: 50_000,
    strategyId: 'strat-1',
    clientOrderId: '00000000-0000-0000-0000-000000000001',
    ...overrides,
  };
}

function makeNoAction(): AgentAction {
  return {
    type: AgentActionType.NoAction,
    reason: 'No signal',
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('RiskEngine', () => {
  let config: SecurityConfig;
  let logger: Logger;
  let alertBus: AlertBus;
  let killSwitch: KillSwitch;
  let positionChecker: PositionLimitsChecker;
  let lossMonitor: LossMonitor;
  let velocityBreaker: CircuitBreaker;
  let errorRateBreaker: CircuitBreaker;
  let lossBreaker: CircuitBreaker;

  beforeEach(() => {
    config = createConfig();
    logger = createMockLogger();
    alertBus = createMockAlertBus();

    const ksRedis = createMockRedis();
    killSwitch = new KillSwitch(config, logger, alertBus, ksRedis);

    positionChecker = new PositionLimitsChecker(config, logger, alertBus);

    const lmRedis = createMockRedis();
    lossMonitor = new LossMonitor(config, logger, alertBus, killSwitch, lmRedis);

    const vRedis = createMockRedis();
    velocityBreaker = new CircuitBreaker('velocity', 50, 60_000, 30_000, logger, alertBus, vRedis);

    const eRedis = createMockRedis();
    errorRateBreaker = new CircuitBreaker('errorRate', 5, 60_000, 30_000, logger, alertBus, eRedis);

    const lRedis = createMockRedis();
    lossBreaker = new CircuitBreaker('loss', 3, 60_000, 30_000, logger, alertBus, lRedis);
  });

  function createEngine(): RiskEngine {
    return new RiskEngine(
      config,
      logger,
      alertBus,
      killSwitch,
      positionChecker,
      lossMonitor,
      velocityBreaker,
      errorRateBreaker,
      lossBreaker,
    );
  }

  describe('kill switch checks', () => {
    it('should block when global kill switch is active', async () => {
      await killSwitch.trigger({ type: 'GLOBAL' }, 'halt', 'admin');
      const engine = createEngine();
      const result = await engine.evaluate(makeNoAction(), makeContext());

      expect(result.approved).toBe(false);
      expect(result.riskLevel).toBe(RiskLevel.CRITICAL);
      expect(result.blockReasons).toContain('Kill switch is active');
    });

    it('should block when user kill switch is active', async () => {
      await killSwitch.trigger({ type: 'USER', userId: 'user-1' }, 'loss', 'system');
      const engine = createEngine();
      const result = await engine.evaluate(makeNoAction(), makeContext());

      expect(result.approved).toBe(false);
      expect(result.blockReasons).toContain('Kill switch is active');
    });

    it('should block when strategy kill switch is active', async () => {
      await killSwitch.trigger({ type: 'STRATEGY', strategyId: 'strat-1' }, 'drift', 'mon');
      const engine = createEngine();
      const result = await engine.evaluate(makeNoAction(), makeContext());

      expect(result.approved).toBe(false);
    });

    it('should approve when no kill switch is active', async () => {
      const engine = createEngine();
      const result = await engine.evaluate(makeNoAction(), makeContext());
      expect(result.approved).toBe(true);
    });
  });

  describe('circuit breaker checks', () => {
    it('should block when velocity breaker is open', async () => {
      await velocityBreaker.forceOpen('too many orders');
      const engine = createEngine();
      const result = await engine.evaluate(makeNoAction(), makeContext());

      expect(result.approved).toBe(false);
      expect(result.blockReasons).toContain('Velocity circuit breaker is open');
    });

    it('should block when error rate breaker is open', async () => {
      await errorRateBreaker.forceOpen('too many errors');
      const engine = createEngine();
      const result = await engine.evaluate(makeNoAction(), makeContext());

      expect(result.approved).toBe(false);
      expect(result.blockReasons).toContain('Error rate circuit breaker is open');
    });

    it('should block when loss breaker is open', async () => {
      await lossBreaker.forceOpen('heavy losses');
      const engine = createEngine();
      const result = await engine.evaluate(makeNoAction(), makeContext());

      expect(result.approved).toBe(false);
      expect(result.blockReasons).toContain('Loss circuit breaker is open');
    });

    it('should collect all open breaker reasons', async () => {
      await velocityBreaker.forceOpen('v');
      await errorRateBreaker.forceOpen('e');
      const engine = createEngine();
      const result = await engine.evaluate(makeNoAction(), makeContext());

      expect(result.blockReasons).toHaveLength(2);
      expect(result.riskLevel).toBe(RiskLevel.HIGH);
    });
  });

  describe('position limits for orders', () => {
    it('should block PlaceOrder that breaches position limits', async () => {
      const engine = createEngine();
      const order = makePlaceOrder({ quantity: 15 }); // Exceeds limit of 10
      const ctx = makeContext();

      const result = await engine.evaluate(order, ctx);
      expect(result.approved).toBe(false);
      expect(result.blockReasons.some((r) => r.includes('Position limit breached'))).toBe(true);
    });

    it('should approve PlaceOrder within limits', async () => {
      const engine = createEngine();
      const order = makePlaceOrder({ quantity: 1 });
      const result = await engine.evaluate(order, makeContext());

      expect(result.approved).toBe(true);
    });

    it('should not check position limits for non-order actions', async () => {
      const engine = createEngine();
      const spy = vi.spyOn(positionChecker, 'check');
      await engine.evaluate(makeNoAction(), makeContext());
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('loss monitor integration', () => {
    it('should call loss monitor update with portfolio data', async () => {
      const spy = vi.spyOn(lossMonitor, 'update');
      const engine = createEngine();
      const ctx = makeContext();
      await engine.evaluate(makeNoAction(), ctx);

      expect(spy).toHaveBeenCalledWith(ctx.portfolio, ctx.userId, ctx.strategyId);
    });
  });

  describe('risk level computation', () => {
    it('should return LOW risk for NoAction', async () => {
      const engine = createEngine();
      const result = await engine.evaluate(makeNoAction(), makeContext());
      expect(result.riskLevel).toBe(RiskLevel.LOW);
    });

    it('should return MEDIUM risk for PlaceOrder when approved', async () => {
      const engine = createEngine();
      const result = await engine.evaluate(makePlaceOrder({ quantity: 1 }), makeContext());
      expect(result.riskLevel).toBe(RiskLevel.MEDIUM);
    });

    it('should return CRITICAL when kill switch blocks', async () => {
      await killSwitch.trigger({ type: 'GLOBAL' }, 'halt', 'admin');
      const engine = createEngine();
      const result = await engine.evaluate(makeNoAction(), makeContext());
      expect(result.riskLevel).toBe(RiskLevel.CRITICAL);
    });

    it('should return highest risk when multiple blocks combine', async () => {
      await killSwitch.trigger({ type: 'GLOBAL' }, 'halt', 'admin');
      await velocityBreaker.forceOpen('v');
      const engine = createEngine();
      const result = await engine.evaluate(makeNoAction(), makeContext());
      expect(result.riskLevel).toBe(RiskLevel.CRITICAL);
    });
  });

  describe('event emission', () => {
    it('should emit ACTION_ALLOWED when approved', async () => {
      const engine = createEngine();
      await engine.evaluate(makeNoAction(), makeContext());
      expect(alertBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: SecurityEventType.ACTION_ALLOWED,
        }),
      );
    });

    it('should emit ACTION_BLOCKED when blocked', async () => {
      await killSwitch.trigger({ type: 'GLOBAL' }, 'halt', 'admin');
      const engine = createEngine();
      // Clear the emit calls from killSwitch.trigger
      (alertBus.emit as ReturnType<typeof vi.fn>).mockClear();

      await engine.evaluate(makeNoAction(), makeContext());
      expect(alertBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: SecurityEventType.ACTION_BLOCKED,
        }),
      );
    });
  });
});
