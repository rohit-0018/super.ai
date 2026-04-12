import { randomUUID } from 'node:crypto';
import { SecurityEventType, RiskLevel } from '../types/events.js';
import { OrderSide } from '../types/actions.js';
import type { PlaceOrderAction } from '../types/actions.js';
import type { PortfolioSnapshot } from '../types/risk.js';
import { ComplianceError, SecurityErrorCode } from '../types/errors.js';

// ─── Interfaces ─────────────────────────────────────────────────────────────

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

export enum AccountType {
  CASH = 'CASH',
  MARGIN = 'MARGIN',
  PROFESSIONAL = 'PROFESSIONAL',
}

export interface ShortSellCheckResult {
  allowed: boolean;
  isShortSale: boolean;
  shortQuantity?: number;
}

// ─── ShortSellControl ───────────────────────────────────────────────────────

export class ShortSellControl {
  private readonly logger: Logger;
  private readonly alertBus: AlertBus;

  constructor(logger: Logger, alertBus: AlertBus) {
    this.logger = logger;
    this.alertBus = alertBus;
  }

  public async check(
    action: PlaceOrderAction,
    portfolio: PortfolioSnapshot,
    accountType: AccountType,
  ): Promise<ShortSellCheckResult> {
    // Only sell orders can be short sales
    if (action.side !== OrderSide.SELL) {
      return { allowed: true, isShortSale: false };
    }

    const currentQuantity = this.getCurrentQuantity(
      action.instrument,
      portfolio,
    );

    // User holds enough to cover the sell
    if (action.quantity <= currentQuantity) {
      return { allowed: true, isShortSale: false };
    }

    // This is a short sale
    const shortQuantity = action.quantity - currentQuantity;

    // MARGIN and PROFESSIONAL accounts are allowed to short sell
    if (
      accountType === AccountType.MARGIN ||
      accountType === AccountType.PROFESSIONAL
    ) {
      this.logger.info('Short sale permitted for margin/professional account', {
        instrument: action.instrument,
        shortQuantity,
        accountType,
        strategyId: action.strategyId,
      });

      return {
        allowed: true,
        isShortSale: true,
        shortQuantity,
      };
    }

    // CASH accounts cannot short sell
    const correlationId = randomUUID();

    this.logger.warn('Short sell blocked for cash account', {
      instrument: action.instrument,
      shortQuantity,
      accountType,
      strategyId: action.strategyId,
      correlationId,
    });

    this.alertBus.emit({
      level: RiskLevel.HIGH,
      type: SecurityEventType.SHORT_SELL_BLOCKED,
      message: `Short sell blocked for ${action.instrument}: cash account cannot short sell`,
      correlationId,
      metadata: {
        instrument: action.instrument,
        strategyId: action.strategyId,
        reason: 'SHORT_SELL_NOT_PERMITTED',
        shortQuantity,
        currentQuantity,
        requestedQuantity: action.quantity,
      },
    });

    throw new ComplianceError(
      `Short selling not permitted for cash account on ${action.instrument}`,
      correlationId,
      SecurityErrorCode.COMPLIANCE_SHORT_SELL_BLOCKED,
      {
        instrument: action.instrument,
        shortQuantity,
        accountType,
        strategyId: action.strategyId,
      },
    );
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private getCurrentQuantity(
    instrument: string,
    portfolio: PortfolioSnapshot,
  ): number {
    const position = portfolio.positions.find(
      (p) => p.instrument === instrument,
    );
    return position?.quantity ?? 0;
  }
}
