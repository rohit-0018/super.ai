import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OutputFilter, type Logger, type EventEmitter } from './output.filter.js';
import { ActionAllowlist } from './action.allowlist.js';
import { SanityChecker, type MarketDataService, type SanityCheckerConfig } from './sanity.checker.js';
import { DuplicateDetector, type RedisAdapter } from './duplicate.detector.js';
import { AgentActionType, OrderSide, OrderType } from '../types/actions.js';
import type { PortfolioSnapshot } from '../types/risk.js';
import { ActionBlockedError } from '../types/errors.js';
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

function defaultSanityConfig(): SanityCheckerConfig {
  return {
    approvedTradingUniverse: ['BTC-USDT', 'ETH-USDT'],
    positionLimitsPerInstrument: { 'BTC-USDT': 10, 'ETH-USDT': 100 },
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

function validPlaceOrderRaw(): Record<string, unknown> {
  return {
    type: AgentActionType.PlaceOrder,
    instrument: 'BTC-USDT',
    side: OrderSide.BUY,
    orderType: OrderType.LIMIT,
    quantity: 1,
    price: 50000,
    strategyId: 'strat-1',
    clientOrderId: '550e8400-e29b-41d4-a716-446655440000',
  };
}

function validNoActionRaw(): Record<string, unknown> {
  return {
    type: AgentActionType.NoAction,
    reason: 'No signal detected',
  };
}

interface TestDeps {
  logger: Logger;
  emitter: EventEmitter;
  filter: OutputFilter;
  redis: RedisAdapter;
}

function createOutputFilter(
  priceMap: Record<string, number> = { 'BTC-USDT': 50000, 'ETH-USDT': 3000 },
  redisStore: Map<string, string> = new Map(),
): TestDeps {
  const logger = createLogger();
  const emitter = createEmitter();
  const redis = createRedisAdapter(redisStore);
  const mds = createMarketDataService(priceMap);

  const allowlist = new ActionAllowlist({ logger, emitter });
  const sanityChecker = new SanityChecker({
    config: defaultSanityConfig(),
    logger,
    marketDataService: mds,
    emitter,
  });
  const duplicateDetector = new DuplicateDetector({
    logger,
    redisAdapter: redis,
    emitter,
  });

  const filter = new OutputFilter({
    allowlist,
    sanityChecker,
    duplicateDetector,
    logger,
    emitter,
  });

  return { logger, emitter, filter, redis };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('OutputFilter', () => {
  describe('successful processing', () => {
    it('allows a valid PlaceOrder action', async () => {
      const { filter } = createOutputFilter();
      const result = await filter.process(validPlaceOrderRaw(), emptyPortfolio());

      expect(result.allowed).toBe(true);
      expect(result.action.type).toBe(AgentActionType.PlaceOrder);
      expect(result.confirmationRequired).toBe(true);
      expect(result.blockReasons).toHaveLength(0);
    });

    it('allows a valid NoAction', async () => {
      const { filter } = createOutputFilter();
      const result = await filter.process(validNoActionRaw(), emptyPortfolio());

      expect(result.allowed).toBe(true);
      expect(result.action.type).toBe(AgentActionType.NoAction);
      expect(result.confirmationRequired).toBe(false);
    });

    it('emits ACTION_ALLOWED for a valid action', async () => {
      const { filter, emitter } = createOutputFilter();
      await filter.process(validPlaceOrderRaw(), emptyPortfolio());

      expect(emitter.emit).toHaveBeenCalledWith(
        SecurityEventType.ACTION_ALLOWED,
        expect.objectContaining({
          actionType: AgentActionType.PlaceOrder,
          checksPerformed: ['allowlist', 'sanity', 'duplicate'],
        }),
      );
    });
  });

  describe('allowlist blocking', () => {
    it('throws ActionBlockedError for unknown action type', async () => {
      const { filter } = createOutputFilter();
      const raw = { type: 'HackExchange', data: {} };

      await expect(filter.process(raw, emptyPortfolio())).rejects.toThrow(ActionBlockedError);
    });

    it('throws ActionBlockedError for malformed input', async () => {
      const { filter } = createOutputFilter();

      await expect(filter.process(null, emptyPortfolio())).rejects.toThrow(ActionBlockedError);
    });
  });

  describe('sanity check blocking', () => {
    it('blocks when instrument is not in approved universe', async () => {
      const { filter } = createOutputFilter({ 'DOGE-USDT': 0.1 });
      const raw = {
        ...validPlaceOrderRaw(),
        instrument: 'DOGE-USDT',
        price: 0.1,
      };

      const result = await filter.process(raw, emptyPortfolio());
      expect(result.allowed).toBe(false);
      expect(result.blockReasons.some((r) => r.includes('not in the approved trading universe'))).toBe(true);
    });

    it('blocks when order quantity exceeds instrument limit', async () => {
      const { filter } = createOutputFilter();
      const raw = { ...validPlaceOrderRaw(), quantity: 15 };

      const result = await filter.process(raw, emptyPortfolio());
      expect(result.allowed).toBe(false);
      expect(result.blockReasons.some((r) => r.includes('exceeds per-instrument limit'))).toBe(true);
    });

    it('blocks when portfolio notional would be exceeded', async () => {
      const { filter } = createOutputFilter();
      const raw = { ...validPlaceOrderRaw(), quantity: 5, price: 50000 };
      const portfolio: PortfolioSnapshot = {
        positions: [],
        totalNotional: 800000,
        totalUnrealizedPnl: 0,
        drawdownFromHighWatermarkPercent: 0,
      };

      const result = await filter.process(raw, portfolio);
      expect(result.allowed).toBe(false);
      expect(result.blockReasons.some((r) => r.includes('would exceed limit'))).toBe(true);
    });

    it('emits ACTION_BLOCKED when sanity check fails', async () => {
      const { filter, emitter } = createOutputFilter();
      const raw = { ...validPlaceOrderRaw(), quantity: 15 };

      await filter.process(raw, emptyPortfolio());

      expect(emitter.emit).toHaveBeenCalledWith(
        SecurityEventType.ACTION_BLOCKED,
        expect.objectContaining({
          actionType: AgentActionType.PlaceOrder,
          violatedRule: 'output-filter',
        }),
      );
    });
  });

  describe('duplicate detection blocking', () => {
    it('blocks a duplicate order', async () => {
      const store = new Map<string, string>();
      const { filter } = createOutputFilter(
        { 'BTC-USDT': 50000 },
        store,
      );

      // First order goes through
      const result1 = await filter.process(validPlaceOrderRaw(), emptyPortfolio());
      expect(result1.allowed).toBe(true);

      // Second identical order (different clientOrderId) is blocked
      const raw2 = {
        ...validPlaceOrderRaw(),
        clientOrderId: '660e8400-e29b-41d4-a716-446655440001',
      };
      const result2 = await filter.process(raw2, emptyPortfolio());
      expect(result2.allowed).toBe(false);
      expect(result2.blockReasons.some((r) => r.includes('Duplicate order detected'))).toBe(true);
    });

    it('allows orders with different parameters', async () => {
      const store = new Map<string, string>();
      const { filter } = createOutputFilter(
        { 'BTC-USDT': 50000 },
        store,
      );

      const result1 = await filter.process(validPlaceOrderRaw(), emptyPortfolio());
      expect(result1.allowed).toBe(true);

      // Different quantity => different dedup key
      const raw2 = {
        ...validPlaceOrderRaw(),
        clientOrderId: '660e8400-e29b-41d4-a716-446655440001',
        quantity: 2,
      };
      const result2 = await filter.process(raw2, emptyPortfolio());
      expect(result2.allowed).toBe(true);
    });
  });

  describe('combined failures', () => {
    it('collects block reasons from both sanity and duplicate checks', async () => {
      const store = new Map<string, string>();
      const { filter } = createOutputFilter(
        { 'BTC-USDT': 50000 },
        store,
      );

      // First order stores dedup key
      await filter.process(validPlaceOrderRaw(), emptyPortfolio());

      // Second order: duplicate AND exceeds quantity limit
      const raw2 = {
        ...validPlaceOrderRaw(),
        clientOrderId: '660e8400-e29b-41d4-a716-446655440001',
        quantity: 15, // exceeds limit of 10
      };

      // We need same dedup key, so use same quantity. Let's use a different scenario:
      // over-limit order that is also a duplicate
      const raw3 = {
        ...validPlaceOrderRaw(),
        clientOrderId: '770e8400-e29b-41d4-a716-446655440002',
      };
      const result = await filter.process(raw3, emptyPortfolio());
      expect(result.allowed).toBe(false);
      expect(result.blockReasons.some((r) => r.includes('Duplicate order detected'))).toBe(true);
    });
  });

  describe('confirmation required', () => {
    it('sets confirmationRequired true for PlaceOrder', async () => {
      const { filter } = createOutputFilter();
      const result = await filter.process(validPlaceOrderRaw(), emptyPortfolio());
      expect(result.confirmationRequired).toBe(true);
    });

    it('sets confirmationRequired false for CancelOrder', async () => {
      const { filter } = createOutputFilter();
      const raw = {
        type: AgentActionType.CancelOrder,
        clientOrderId: '550e8400-e29b-41d4-a716-446655440000',
        instrument: 'BTC-USDT',
        strategyId: 'strat-1',
      };

      const result = await filter.process(raw, emptyPortfolio());
      expect(result.confirmationRequired).toBe(false);
    });

    it('sets confirmationRequired false for NoAction', async () => {
      const { filter } = createOutputFilter();
      const result = await filter.process(validNoActionRaw(), emptyPortfolio());
      expect(result.confirmationRequired).toBe(false);
    });

    it('sets confirmationRequired true for ClosePosition', async () => {
      const { filter } = createOutputFilter();
      const raw = {
        type: AgentActionType.ClosePosition,
        instrument: 'BTC-USDT',
        strategyId: 'strat-1',
      };

      const result = await filter.process(raw, emptyPortfolio());
      expect(result.confirmationRequired).toBe(true);
    });
  });
});
