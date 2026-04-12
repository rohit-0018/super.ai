import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SanityChecker,
  type Logger,
  type EventEmitter,
  type MarketDataService,
  type SanityCheckerConfig,
} from './sanity.checker.js';
import { AgentActionType, OrderSide, OrderType } from '../types/actions.js';
import type { AgentAction, PlaceOrderAction, CancelOrderAction, ModifyOrderAction } from '../types/actions.js';
import type { PortfolioSnapshot } from '../types/risk.js';
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

function createMarketDataService(priceMap: Record<string, number> = {}): MarketDataService {
  return {
    getCurrentPrice: vi.fn(async (instrument: string): Promise<number> => {
      const price = priceMap[instrument];
      if (price === undefined) {
        throw new Error(`No price for ${instrument}`);
      }
      return price;
    }),
  };
}

function defaultConfig(): SanityCheckerConfig {
  return {
    approvedTradingUniverse: ['BTC-USDT', 'ETH-USDT', 'SOL-USDT'],
    positionLimitsPerInstrument: {
      'BTC-USDT': 10,
      'ETH-USDT': 100,
      'SOL-USDT': 1000,
    },
    portfolioNotionalLimit: 1_000_000,
    feedConsensusDivergenceThresholdPercent: 1.5,
  };
}

function emptyPortfolio(): PortfolioSnapshot {
  return {
    positions: [],
    totalNotional: 0,
    totalUnrealizedPnl: 0,
    drawdownFromHighWatermarkPercent: 0,
  };
}

function portfolioWithNotional(totalNotional: number): PortfolioSnapshot {
  return {
    positions: [],
    totalNotional,
    totalUnrealizedPnl: 0,
    drawdownFromHighWatermarkPercent: 0,
  };
}

function validPlaceOrder(overrides: Partial<PlaceOrderAction> = {}): PlaceOrderAction {
  return {
    type: AgentActionType.PlaceOrder,
    instrument: 'BTC-USDT',
    side: OrderSide.BUY,
    orderType: OrderType.LIMIT,
    quantity: 1,
    price: 50000,
    strategyId: 'strat-1',
    clientOrderId: '550e8400-e29b-41d4-a716-446655440000',
    ...overrides,
  };
}

function validCancelOrder(): CancelOrderAction {
  return {
    type: AgentActionType.CancelOrder,
    clientOrderId: '550e8400-e29b-41d4-a716-446655440000',
    instrument: 'BTC-USDT',
    strategyId: 'strat-1',
  };
}

function validModifyOrder(): ModifyOrderAction {
  return {
    type: AgentActionType.ModifyOrder,
    clientOrderId: '550e8400-e29b-41d4-a716-446655440000',
    instrument: 'BTC-USDT',
    newQuantity: 2,
    strategyId: 'strat-1',
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('SanityChecker', () => {
  let logger: Logger;
  let emitter: EventEmitter;

  beforeEach(() => {
    logger = createLogger();
    emitter = createEmitter();
  });

  // ── PlaceOrder: approved universe ───────────────────────────────────────

  describe('PlaceOrder - approved universe', () => {
    it('passes when instrument is in approved universe', async () => {
      const mds = createMarketDataService({ 'BTC-USDT': 50000 });
      const checker = new SanityChecker({
        config: defaultConfig(),
        logger,
        marketDataService: mds,
        emitter,
      });

      const result = await checker.check(validPlaceOrder(), emptyPortfolio());
      expect(result.passed).toBe(true);
      expect(result.failures).toHaveLength(0);
    });

    it('fails when instrument is not in approved universe', async () => {
      const mds = createMarketDataService({ 'DOGE-USDT': 0.1 });
      const checker = new SanityChecker({
        config: defaultConfig(),
        logger,
        marketDataService: mds,
        emitter,
      });

      const action = validPlaceOrder({ instrument: 'DOGE-USDT', price: 0.1 });
      const result = await checker.check(action, emptyPortfolio());
      expect(result.passed).toBe(false);
      expect(result.failures.some((f) => f.includes('not in the approved trading universe'))).toBe(true);
    });

    it('skips universe check when approved universe is empty', async () => {
      const config = { ...defaultConfig(), approvedTradingUniverse: [] };
      const mds = createMarketDataService({ 'DOGE-USDT': 0.1 });
      const checker = new SanityChecker({
        config,
        logger,
        marketDataService: mds,
        emitter,
      });

      const action = validPlaceOrder({ instrument: 'DOGE-USDT', price: 0.1 });
      const result = await checker.check(action, emptyPortfolio());
      // Should not fail on universe check (may fail on other checks like pair format)
      expect(result.failures.some((f) => f.includes('not in the approved trading universe'))).toBe(false);
    });
  });

  // ── PlaceOrder: per-instrument limit ────────────────────────────────────

  describe('PlaceOrder - per-instrument limit', () => {
    it('passes when quantity is within limit', async () => {
      const mds = createMarketDataService({ 'BTC-USDT': 50000 });
      const checker = new SanityChecker({
        config: defaultConfig(),
        logger,
        marketDataService: mds,
        emitter,
      });

      const action = validPlaceOrder({ quantity: 5 });
      const result = await checker.check(action, emptyPortfolio());
      expect(result.passed).toBe(true);
    });

    it('fails when quantity exceeds per-instrument limit', async () => {
      const mds = createMarketDataService({ 'BTC-USDT': 50000 });
      const checker = new SanityChecker({
        config: defaultConfig(),
        logger,
        marketDataService: mds,
        emitter,
      });

      const action = validPlaceOrder({ quantity: 15 });
      const result = await checker.check(action, emptyPortfolio());
      expect(result.passed).toBe(false);
      expect(result.failures.some((f) => f.includes('exceeds per-instrument limit'))).toBe(true);
    });
  });

  // ── PlaceOrder: price tolerance ─────────────────────────────────────────

  describe('PlaceOrder - price tolerance', () => {
    it('passes when limit price is within tolerance', async () => {
      const mds = createMarketDataService({ 'BTC-USDT': 50000 });
      const checker = new SanityChecker({
        config: defaultConfig(),
        logger,
        marketDataService: mds,
        emitter,
      });

      // 1.5% tolerance => 49250 - 50750
      const action = validPlaceOrder({ price: 50500 });
      const result = await checker.check(action, emptyPortfolio());
      expect(result.passed).toBe(true);
    });

    it('fails when limit price is outside tolerance', async () => {
      const mds = createMarketDataService({ 'BTC-USDT': 50000 });
      const checker = new SanityChecker({
        config: defaultConfig(),
        logger,
        marketDataService: mds,
        emitter,
      });

      // 1.5% tolerance => 49250 - 50750, price 52000 is outside
      const action = validPlaceOrder({ price: 52000 });
      const result = await checker.check(action, emptyPortfolio());
      expect(result.passed).toBe(false);
      expect(result.failures.some((f) => f.includes('outside') && f.includes('tolerance'))).toBe(true);
    });

    it('adds failure when market data service throws', async () => {
      const mds = createMarketDataService({}); // No prices
      const checker = new SanityChecker({
        config: defaultConfig(),
        logger,
        marketDataService: mds,
        emitter,
      });

      const action = validPlaceOrder({ price: 50000 });
      const result = await checker.check(action, emptyPortfolio());
      expect(result.passed).toBe(false);
      expect(result.failures.some((f) => f.includes('Failed to fetch current price'))).toBe(true);
    });
  });

  // ── PlaceOrder: portfolio notional limit ────────────────────────────────

  describe('PlaceOrder - portfolio notional limit', () => {
    it('passes when projected notional is within limit', async () => {
      const mds = createMarketDataService({ 'BTC-USDT': 50000 });
      const checker = new SanityChecker({
        config: defaultConfig(),
        logger,
        marketDataService: mds,
        emitter,
      });

      const action = validPlaceOrder({ quantity: 1, price: 50000 });
      const result = await checker.check(action, portfolioWithNotional(900000));
      expect(result.passed).toBe(true);
    });

    it('fails when projected notional exceeds limit', async () => {
      const mds = createMarketDataService({ 'BTC-USDT': 50000 });
      const checker = new SanityChecker({
        config: defaultConfig(),
        logger,
        marketDataService: mds,
        emitter,
      });

      const action = validPlaceOrder({ quantity: 5, price: 50000 });
      // 5 * 50000 = 250000 + 800000 = 1050000 > 1000000
      const result = await checker.check(action, portfolioWithNotional(800000));
      expect(result.passed).toBe(false);
      expect(result.failures.some((f) => f.includes('would exceed limit'))).toBe(true);
    });
  });

  // ── PlaceOrder: instrument format ───────────────────────────────────────

  describe('PlaceOrder - instrument format', () => {
    it('passes for instrument with dash separator', async () => {
      const mds = createMarketDataService({ 'BTC-USDT': 50000 });
      const checker = new SanityChecker({
        config: defaultConfig(),
        logger,
        marketDataService: mds,
        emitter,
      });

      const result = await checker.check(validPlaceOrder(), emptyPortfolio());
      expect(result.failures.some((f) => f.includes('pair format'))).toBe(false);
    });

    it('fails for instrument without separator', async () => {
      const config = { ...defaultConfig(), approvedTradingUniverse: ['BTCUSDT'] };
      const mds = createMarketDataService({ 'BTCUSDT': 50000 });
      const checker = new SanityChecker({
        config,
        logger,
        marketDataService: mds,
        emitter,
      });

      const action = validPlaceOrder({ instrument: 'BTCUSDT', price: 50000 });
      const result = await checker.check(action, emptyPortfolio());
      expect(result.failures.some((f) => f.includes('pair format'))).toBe(true);
    });
  });

  // ── CancelOrder: valid UUID ─────────────────────────────────────────────

  describe('CancelOrder', () => {
    it('passes with valid UUID clientOrderId', async () => {
      const mds = createMarketDataService();
      const checker = new SanityChecker({
        config: defaultConfig(),
        logger,
        marketDataService: mds,
        emitter,
      });

      const result = await checker.check(validCancelOrder(), emptyPortfolio());
      expect(result.passed).toBe(true);
    });

    it('fails with non-UUID clientOrderId', async () => {
      const mds = createMarketDataService();
      const checker = new SanityChecker({
        config: defaultConfig(),
        logger,
        marketDataService: mds,
        emitter,
      });

      // We need to bypass Zod validation for this test. The CancelOrder schema
      // enforces UUID, but sanity checker does its own check too.
      // Construct the action directly to test the checker.
      const action = {
        type: AgentActionType.CancelOrder as const,
        clientOrderId: 'not-a-uuid',
        instrument: 'BTC-USDT',
        strategyId: 'strat-1',
      };

      const result = await checker.check(action, emptyPortfolio());
      expect(result.passed).toBe(false);
      expect(result.failures.some((f) => f.includes('not a valid UUID'))).toBe(true);
    });
  });

  // ── ModifyOrder: valid UUID ─────────────────────────────────────────────

  describe('ModifyOrder', () => {
    it('passes with valid UUID clientOrderId', async () => {
      const mds = createMarketDataService();
      const checker = new SanityChecker({
        config: defaultConfig(),
        logger,
        marketDataService: mds,
        emitter,
      });

      const result = await checker.check(validModifyOrder(), emptyPortfolio());
      expect(result.passed).toBe(true);
    });

    it('fails with non-UUID clientOrderId', async () => {
      const mds = createMarketDataService();
      const checker = new SanityChecker({
        config: defaultConfig(),
        logger,
        marketDataService: mds,
        emitter,
      });

      const action = {
        type: AgentActionType.ModifyOrder as const,
        clientOrderId: 'bad-id',
        instrument: 'BTC-USDT',
        newQuantity: 2,
        strategyId: 'strat-1',
      };

      const result = await checker.check(action, emptyPortfolio());
      expect(result.passed).toBe(false);
      expect(result.failures.some((f) => f.includes('not a valid UUID'))).toBe(true);
    });
  });

  // ── Non-trade actions ───────────────────────────────────────────────────

  describe('non-trade actions', () => {
    it('passes for ClosePosition without checks', async () => {
      const mds = createMarketDataService();
      const checker = new SanityChecker({
        config: defaultConfig(),
        logger,
        marketDataService: mds,
        emitter,
      });

      const action: AgentAction = {
        type: AgentActionType.ClosePosition,
        instrument: 'BTC-USDT',
        strategyId: 'strat-1',
      };
      const result = await checker.check(action, emptyPortfolio());
      expect(result.passed).toBe(true);
    });

    it('passes for NoAction without checks', async () => {
      const mds = createMarketDataService();
      const checker = new SanityChecker({
        config: defaultConfig(),
        logger,
        marketDataService: mds,
        emitter,
      });

      const action: AgentAction = {
        type: AgentActionType.NoAction,
        reason: 'No signal',
      };
      const result = await checker.check(action, emptyPortfolio());
      expect(result.passed).toBe(true);
    });
  });

  // ── Event emission ──────────────────────────────────────────────────────

  describe('event emission', () => {
    it('emits SANITY_CHECK_FAILED for each failure', async () => {
      const mds = createMarketDataService({ 'BTC-USDT': 50000 });
      const checker = new SanityChecker({
        config: defaultConfig(),
        logger,
        marketDataService: mds,
        emitter,
      });

      // Quantity exceeds limit (15 > 10)
      const action = validPlaceOrder({ quantity: 15 });
      await checker.check(action, emptyPortfolio());

      expect(emitter.emit).toHaveBeenCalledWith(
        SecurityEventType.SANITY_CHECK_FAILED,
        expect.objectContaining({
          actionType: AgentActionType.PlaceOrder,
          strategyId: 'strat-1',
        }),
      );
    });

    it('does not emit events when all checks pass', async () => {
      const mds = createMarketDataService({ 'BTC-USDT': 50000 });
      const checker = new SanityChecker({
        config: defaultConfig(),
        logger,
        marketDataService: mds,
        emitter,
      });

      await checker.check(validPlaceOrder(), emptyPortfolio());
      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });

  // ── Multiple failures ───────────────────────────────────────────────────

  describe('multiple failures', () => {
    it('collects all failures for a single action', async () => {
      const mds = createMarketDataService({ 'DOGE-USDT': 0.1 });
      const config: SanityCheckerConfig = {
        ...defaultConfig(),
        portfolioNotionalLimit: 100,
      };
      const checker = new SanityChecker({
        config,
        logger,
        marketDataService: mds,
        emitter,
      });

      // Not in universe, no separator
      const action = validPlaceOrder({
        instrument: 'DOGEUSDT',
        price: 0.1,
        quantity: 5000,
      });
      const result = await checker.check(action, emptyPortfolio());
      expect(result.passed).toBe(false);
      expect(result.failures.length).toBeGreaterThanOrEqual(2);
    });
  });
});
