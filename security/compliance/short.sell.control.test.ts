import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ShortSellControl, AccountType } from './short.sell.control.js';
import type { Logger, AlertBus } from './short.sell.control.js';
import type { PlaceOrderAction } from '../types/actions.js';
import { AgentActionType, OrderSide, OrderType } from '../types/actions.js';
import type { PortfolioSnapshot } from '../types/risk.js';
import { ComplianceError, SecurityErrorCode } from '../types/errors.js';
import { SecurityEventType, RiskLevel } from '../types/events.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeAction(overrides: Partial<PlaceOrderAction> = {}): PlaceOrderAction {
  return {
    type: AgentActionType.PlaceOrder,
    instrument: 'BTC-USDT',
    side: OrderSide.SELL,
    orderType: OrderType.MARKET,
    quantity: 5.0,
    strategyId: 'strat-1',
    clientOrderId: 'order-aaa-111',
    ...overrides,
  };
}

function makePortfolio(
  positions: Array<{ instrument: string; quantity: number }> = [],
): PortfolioSnapshot {
  return {
    positions: positions.map((p) => ({
      instrument: p.instrument,
      quantity: p.quantity,
      averageEntryPrice: 50000,
      currentPrice: 50000,
      unrealizedPnl: 0,
      notionalValue: Math.abs(p.quantity) * 50000,
    })),
    totalNotional: positions.reduce(
      (sum, p) => sum + Math.abs(p.quantity) * 50000,
      0,
    ),
    totalUnrealizedPnl: 0,
    drawdownFromHighWatermarkPercent: 0,
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

describe('ShortSellControl', () => {
  let logger: Logger;
  let alertBus: AlertBus;
  let control: ShortSellControl;

  beforeEach(() => {
    logger = makeLogger();
    alertBus = makeAlertBus();
    control = new ShortSellControl(logger, alertBus);
  });

  it('allows buy orders without any checks', async () => {
    const result = await control.check(
      makeAction({ side: OrderSide.BUY }),
      makePortfolio(),
      AccountType.CASH,
    );

    expect(result.allowed).toBe(true);
    expect(result.isShortSale).toBe(false);
  });

  it('allows sell orders when user holds sufficient quantity', async () => {
    const result = await control.check(
      makeAction({ quantity: 3.0 }),
      makePortfolio([{ instrument: 'BTC-USDT', quantity: 5.0 }]),
      AccountType.CASH,
    );

    expect(result.allowed).toBe(true);
    expect(result.isShortSale).toBe(false);
  });

  it('allows sell orders when quantity exactly matches holding', async () => {
    const result = await control.check(
      makeAction({ quantity: 5.0 }),
      makePortfolio([{ instrument: 'BTC-USDT', quantity: 5.0 }]),
      AccountType.CASH,
    );

    expect(result.allowed).toBe(true);
    expect(result.isShortSale).toBe(false);
  });

  it('allows short sell for MARGIN accounts', async () => {
    const result = await control.check(
      makeAction({ quantity: 10.0 }),
      makePortfolio([{ instrument: 'BTC-USDT', quantity: 3.0 }]),
      AccountType.MARGIN,
    );

    expect(result.allowed).toBe(true);
    expect(result.isShortSale).toBe(true);
    expect(result.shortQuantity).toBe(7.0);
  });

  it('allows short sell for PROFESSIONAL accounts', async () => {
    const result = await control.check(
      makeAction({ quantity: 10.0 }),
      makePortfolio([{ instrument: 'BTC-USDT', quantity: 3.0 }]),
      AccountType.PROFESSIONAL,
    );

    expect(result.allowed).toBe(true);
    expect(result.isShortSale).toBe(true);
    expect(result.shortQuantity).toBe(7.0);
  });

  it('blocks short sell for CASH accounts and throws ComplianceError', async () => {
    await expect(
      control.check(
        makeAction({ quantity: 10.0 }),
        makePortfolio([{ instrument: 'BTC-USDT', quantity: 3.0 }]),
        AccountType.CASH,
      ),
    ).rejects.toThrow(ComplianceError);
  });

  it('throws with correct error code for CASH short sell', async () => {
    try {
      await control.check(
        makeAction({ quantity: 10.0 }),
        makePortfolio([{ instrument: 'BTC-USDT', quantity: 3.0 }]),
        AccountType.CASH,
      );
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ComplianceError);
      const ce = err as ComplianceError;
      expect(ce.code).toBe(SecurityErrorCode.COMPLIANCE_SHORT_SELL_BLOCKED);
    }
  });

  it('emits SHORT_SELL_BLOCKED alert for CASH accounts', async () => {
    try {
      await control.check(
        makeAction({ quantity: 10.0 }),
        makePortfolio([{ instrument: 'BTC-USDT', quantity: 3.0 }]),
        AccountType.CASH,
      );
    } catch {
      // expected
    }

    expect(alertBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        level: RiskLevel.HIGH,
        type: SecurityEventType.SHORT_SELL_BLOCKED,
      }),
    );
  });

  it('blocks short sell when user holds no position in the instrument', async () => {
    await expect(
      control.check(
        makeAction({ quantity: 5.0 }),
        makePortfolio(), // no positions
        AccountType.CASH,
      ),
    ).rejects.toThrow(ComplianceError);
  });

  it('logs info for permitted margin short sales', async () => {
    await control.check(
      makeAction({ quantity: 10.0 }),
      makePortfolio([{ instrument: 'BTC-USDT', quantity: 3.0 }]),
      AccountType.MARGIN,
    );

    expect(logger.info).toHaveBeenCalledWith(
      'Short sale permitted for margin/professional account',
      expect.objectContaining({
        instrument: 'BTC-USDT',
        shortQuantity: 7.0,
        accountType: AccountType.MARGIN,
      }),
    );
  });

  it('logs warning for blocked short sales', async () => {
    try {
      await control.check(
        makeAction({ quantity: 10.0 }),
        makePortfolio([{ instrument: 'BTC-USDT', quantity: 3.0 }]),
        AccountType.CASH,
      );
    } catch {
      // expected
    }

    expect(logger.warn).toHaveBeenCalledWith(
      'Short sell blocked for cash account',
      expect.objectContaining({
        instrument: 'BTC-USDT',
        shortQuantity: 7.0,
        accountType: AccountType.CASH,
      }),
    );
  });

  it('handles different instruments in portfolio correctly', async () => {
    // User holds ETH but selling BTC
    await expect(
      control.check(
        makeAction({ instrument: 'BTC-USDT', quantity: 5.0 }),
        makePortfolio([{ instrument: 'ETH-USDT', quantity: 100.0 }]),
        AccountType.CASH,
      ),
    ).rejects.toThrow(ComplianceError);
  });
});
