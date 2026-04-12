import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PositionLimitsChecker } from './position.limits.js';
import type { LimitCheckResult } from './position.limits.js';
import type { PlaceOrderAction } from '../types/actions.js';
import { AgentActionType, OrderSide, OrderType } from '../types/actions.js';
import type { PortfolioSnapshot, PositionSnapshot } from '../types/risk.js';
import type { SecurityConfig } from '../types/config.js';
import type { Logger, AlertBus } from './circuit.breaker.js';
import { SecurityEventType } from '../types/events.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function createMockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function createMockAlertBus(): AlertBus {
  return { emit: vi.fn() };
}

function createConfig(overrides?: Partial<SecurityConfig>): SecurityConfig {
  return {
    positionLimitsPerInstrument: { 'BTC-USDT': 10, 'ETH-USDT': 100 },
    portfolioNotionalLimit: 1_000_000,
    ...overrides,
  } as SecurityConfig;
}

function makeOrder(overrides?: Partial<PlaceOrderAction>): PlaceOrderAction {
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

function makePosition(overrides?: Partial<PositionSnapshot>): PositionSnapshot {
  return {
    instrument: 'BTC-USDT',
    quantity: 5,
    averageEntryPrice: 48_000,
    currentPrice: 50_000,
    unrealizedPnl: 10_000,
    notionalValue: 250_000,
    ...overrides,
  };
}

function makePortfolio(
  positions: PositionSnapshot[] = [],
  overrides?: Partial<PortfolioSnapshot>,
): PortfolioSnapshot {
  const totalNotional = positions.reduce((s, p) => s + p.notionalValue, 0);
  const totalPnl = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
  return {
    positions,
    totalNotional,
    totalUnrealizedPnl: totalPnl,
    drawdownFromHighWatermarkPercent: 0,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('PositionLimitsChecker', () => {
  let logger: Logger;
  let alertBus: AlertBus;

  beforeEach(() => {
    logger = createMockLogger();
    alertBus = createMockAlertBus();
  });

  describe('per-instrument quantity limit', () => {
    it('should pass when projected quantity is within limit', async () => {
      const checker = new PositionLimitsChecker(createConfig(), logger, alertBus);
      const portfolio = makePortfolio([makePosition({ quantity: 5 })]);
      const order = makeOrder({ quantity: 3, side: OrderSide.BUY });

      const result = await checker.check(order, portfolio);
      expect(result.passed).toBe(true);
      expect(result.breaches).toHaveLength(0);
    });

    it('should breach when buy exceeds quantity limit', async () => {
      const checker = new PositionLimitsChecker(createConfig(), logger, alertBus);
      const portfolio = makePortfolio([makePosition({ quantity: 8 })]);
      const order = makeOrder({ quantity: 5, side: OrderSide.BUY });

      const result = await checker.check(order, portfolio);
      expect(result.passed).toBe(false);
      expect(result.breaches).toContainEqual(
        expect.objectContaining({
          limit: 'per-instrument-quantity:BTC-USDT',
          current: 13,
          maximum: 10,
        }),
      );
    });

    it('should pass when instrument has no defined limit', async () => {
      const checker = new PositionLimitsChecker(createConfig(), logger, alertBus);
      const portfolio = makePortfolio([]);
      const order = makeOrder({ instrument: 'DOGE-USDT', quantity: 1_000_000 });

      const result = await checker.check(order, portfolio);
      // No quantity or notional breach since no limit is defined for DOGE
      const quantityBreaches = result.breaches.filter((b) =>
        b.limit.startsWith('per-instrument'),
      );
      expect(quantityBreaches).toHaveLength(0);
    });
  });

  describe('portfolio total notional limit', () => {
    it('should pass when total notional is within limit', async () => {
      const checker = new PositionLimitsChecker(createConfig(), logger, alertBus);
      const portfolio = makePortfolio(
        [makePosition({ notionalValue: 500_000 })],
        { totalNotional: 500_000 },
      );
      const order = makeOrder({ quantity: 1, price: 50_000 });

      const result = await checker.check(order, portfolio);
      const portfolioBreaches = result.breaches.filter(
        (b) => b.limit === 'portfolio-total-notional',
      );
      expect(portfolioBreaches).toHaveLength(0);
    });

    it('should breach when buy pushes total notional over limit', async () => {
      const checker = new PositionLimitsChecker(createConfig(), logger, alertBus);
      const portfolio = makePortfolio(
        [makePosition({ notionalValue: 960_000 })],
        { totalNotional: 960_000 },
      );
      const order = makeOrder({ quantity: 1, price: 50_000, side: OrderSide.BUY });

      const result = await checker.check(order, portfolio);
      expect(result.breaches).toContainEqual(
        expect.objectContaining({
          limit: 'portfolio-total-notional',
          maximum: 1_000_000,
        }),
      );
    });

    it('should not breach portfolio notional on sell orders', async () => {
      const checker = new PositionLimitsChecker(createConfig(), logger, alertBus);
      const portfolio = makePortfolio(
        [makePosition({ quantity: 5, notionalValue: 990_000 })],
        { totalNotional: 990_000 },
      );
      const order = makeOrder({ quantity: 2, side: OrderSide.SELL, price: 50_000 });

      const result = await checker.check(order, portfolio);
      const portfolioBreaches = result.breaches.filter(
        (b) => b.limit === 'portfolio-total-notional',
      );
      expect(portfolioBreaches).toHaveLength(0);
    });
  });

  describe('short selling rules', () => {
    it('should breach when selling more than held (short sell)', async () => {
      const checker = new PositionLimitsChecker(createConfig(), logger, alertBus);
      const portfolio = makePortfolio([makePosition({ quantity: 2 })]);
      const order = makeOrder({ quantity: 5, side: OrderSide.SELL, price: 50_000 });

      const result = await checker.check(order, portfolio);
      expect(result.breaches).toContainEqual(
        expect.objectContaining({
          limit: 'short-sell-blocked:BTC-USDT',
          current: 3,
          maximum: 0,
        }),
      );
    });

    it('should pass when selling within held quantity', async () => {
      const checker = new PositionLimitsChecker(createConfig(), logger, alertBus);
      const portfolio = makePortfolio([makePosition({ quantity: 5 })]);
      const order = makeOrder({ quantity: 3, side: OrderSide.SELL, price: 50_000 });

      const result = await checker.check(order, portfolio);
      const shortBreaches = result.breaches.filter((b) =>
        b.limit.startsWith('short-sell'),
      );
      expect(shortBreaches).toHaveLength(0);
    });

    it('should breach when selling instrument with no position (naked short)', async () => {
      const checker = new PositionLimitsChecker(createConfig(), logger, alertBus);
      const portfolio = makePortfolio([]);
      const order = makeOrder({ quantity: 1, side: OrderSide.SELL, price: 50_000 });

      const result = await checker.check(order, portfolio);
      expect(result.breaches).toContainEqual(
        expect.objectContaining({
          limit: 'short-sell-blocked:BTC-USDT',
        }),
      );
    });

    it('should not apply short sell check on buy orders', async () => {
      const checker = new PositionLimitsChecker(createConfig(), logger, alertBus);
      const portfolio = makePortfolio([]);
      const order = makeOrder({ quantity: 1, side: OrderSide.BUY, price: 50_000 });

      const result = await checker.check(order, portfolio);
      const shortBreaches = result.breaches.filter((b) =>
        b.limit.startsWith('short-sell'),
      );
      expect(shortBreaches).toHaveLength(0);
    });
  });

  describe('alert emission', () => {
    it('should emit POSITION_LIMIT_BREACHED when any limit is breached', async () => {
      const checker = new PositionLimitsChecker(createConfig(), logger, alertBus);
      const portfolio = makePortfolio([makePosition({ quantity: 9 })]);
      const order = makeOrder({ quantity: 5, side: OrderSide.BUY });

      await checker.check(order, portfolio);
      expect(alertBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: SecurityEventType.POSITION_LIMIT_BREACHED,
        }),
      );
    });

    it('should not emit alerts when all limits pass', async () => {
      const checker = new PositionLimitsChecker(createConfig(), logger, alertBus);
      const portfolio = makePortfolio([makePosition({ quantity: 2 })]);
      const order = makeOrder({ quantity: 1, side: OrderSide.BUY });

      await checker.check(order, portfolio);
      expect(alertBus.emit).not.toHaveBeenCalled();
    });
  });

  describe('price estimation', () => {
    it('should use order limit price for notional calculation', async () => {
      const checker = new PositionLimitsChecker(createConfig(), logger, alertBus);
      const portfolio = makePortfolio([], { totalNotional: 0 });
      const order = makeOrder({ quantity: 1, price: 60_000, side: OrderSide.BUY });

      const result = await checker.check(order, portfolio);
      // Portfolio notional check: 0 + 60_000 = 60_000 <= 1_000_000 -> pass
      const portfolioBreaches = result.breaches.filter(
        (b) => b.limit === 'portfolio-total-notional',
      );
      expect(portfolioBreaches).toHaveLength(0);
    });

    it('should fall back to current market price when no limit price', async () => {
      const checker = new PositionLimitsChecker(createConfig(), logger, alertBus);
      const portfolio = makePortfolio(
        [makePosition({ instrument: 'BTC-USDT', currentPrice: 50_000, quantity: 0, notionalValue: 0 })],
        { totalNotional: 950_000 },
      );
      // Market order with no price
      const order = makeOrder({
        quantity: 2,
        price: undefined,
        orderType: 'MARKET' as const,
        side: OrderSide.BUY,
      });

      const result = await checker.check(order, portfolio);
      // 950_000 + 2 * 50_000 = 1_050_000 > 1_000_000
      expect(result.breaches).toContainEqual(
        expect.objectContaining({ limit: 'portfolio-total-notional' }),
      );
    });
  });
});
