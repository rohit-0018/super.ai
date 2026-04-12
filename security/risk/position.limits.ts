import { randomUUID } from 'node:crypto';
import type { SecurityConfig } from '../types/config.js';
import { SecurityEventType, RiskLevel } from '../types/events.js';
import type { PlaceOrderAction } from '../types/actions.js';
import { OrderSide } from '../types/actions.js';
import type { PortfolioSnapshot } from '../types/risk.js';
import type { Logger, AlertBus } from './circuit.breaker.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface LimitBreach {
  limit: string;
  current: number;
  maximum: number;
}

export interface LimitCheckResult {
  passed: boolean;
  breaches: LimitBreach[];
}

// ─── PositionLimitsChecker ──────────────────────────────────────────────────

export class PositionLimitsChecker {
  private readonly config: SecurityConfig;
  private readonly logger: Logger;
  private readonly alertBus: AlertBus;

  constructor(config: SecurityConfig, logger: Logger, alertBus: AlertBus) {
    this.config = config;
    this.logger = logger;
    this.alertBus = alertBus;
  }

  public async check(
    action: PlaceOrderAction,
    portfolio: PortfolioSnapshot,
  ): Promise<LimitCheckResult> {
    const breaches: LimitBreach[] = [];

    // 1. Per-instrument quantity limit
    this.checkInstrumentQuantityLimit(action, portfolio, breaches);

    // 2. Per-instrument notional limit (derived from quantity limit * price)
    this.checkInstrumentNotionalLimit(action, portfolio, breaches);

    // 3. Portfolio total notional limit
    this.checkPortfolioNotionalLimit(action, portfolio, breaches);

    // 4. Short selling check for sells of unheld instruments
    this.checkShortSellingRules(action, portfolio, breaches);

    if (breaches.length > 0) {
      const correlationId = randomUUID();
      this.logger.warn(
        `Position limit breached for ${action.instrument}: ${breaches.map((b) => b.limit).join(', ')}`,
        {
          instrument: action.instrument,
          strategyId: action.strategyId,
          breaches,
          correlationId,
        },
      );

      this.alertBus.emit({
        level: RiskLevel.HIGH,
        type: SecurityEventType.POSITION_LIMIT_BREACHED,
        message: `Position limits breached: ${breaches.map((b) => b.limit).join(', ')}`,
        correlationId,
        metadata: {
          instrument: action.instrument,
          strategyId: action.strategyId,
          currentQuantity: this.getCurrentQuantity(action.instrument, portfolio),
          attemptedQuantity: action.quantity,
          limit: breaches[0]?.maximum ?? 0,
        },
      });
    }

    return {
      passed: breaches.length === 0,
      breaches,
    };
  }

  // ─── Private checks ───────────────────────────────────────────────────────

  private checkInstrumentQuantityLimit(
    action: PlaceOrderAction,
    portfolio: PortfolioSnapshot,
    breaches: LimitBreach[],
  ): void {
    const instrumentLimits = this.config.positionLimitsPerInstrument;
    const maxQuantity = instrumentLimits[action.instrument];
    if (maxQuantity === undefined) {
      return; // No quantity limit defined for this instrument
    }

    const currentQty = this.getCurrentQuantity(action.instrument, portfolio);
    const projectedQty =
      action.side === OrderSide.BUY
        ? currentQty + action.quantity
        : currentQty - action.quantity;

    if (Math.abs(projectedQty) > maxQuantity) {
      breaches.push({
        limit: `per-instrument-quantity:${action.instrument}`,
        current: Math.abs(projectedQty),
        maximum: maxQuantity,
      });
    }
  }

  private checkInstrumentNotionalLimit(
    action: PlaceOrderAction,
    portfolio: PortfolioSnapshot,
    breaches: LimitBreach[],
  ): void {
    // Use the order price or current market price for notional estimation
    const price = this.getEstimatedPrice(action, portfolio);
    if (price <= 0) {
      return; // Cannot compute notional without a price
    }

    const instrumentLimits = this.config.positionLimitsPerInstrument;
    const maxQuantity = instrumentLimits[action.instrument];
    if (maxQuantity === undefined) {
      return;
    }

    const maxNotional = maxQuantity * price;
    const currentNotional = this.getCurrentNotional(action.instrument, portfolio);
    const orderNotional = action.quantity * price;
    const projectedNotional =
      action.side === OrderSide.BUY
        ? currentNotional + orderNotional
        : Math.abs(currentNotional - orderNotional);

    if (projectedNotional > maxNotional) {
      breaches.push({
        limit: `per-instrument-notional:${action.instrument}`,
        current: projectedNotional,
        maximum: maxNotional,
      });
    }
  }

  private checkPortfolioNotionalLimit(
    action: PlaceOrderAction,
    portfolio: PortfolioSnapshot,
    breaches: LimitBreach[],
  ): void {
    const maxPortfolioNotional = this.config.portfolioNotionalLimit;
    const price = this.getEstimatedPrice(action, portfolio);
    const orderNotional = action.quantity * price;

    const projectedTotal =
      action.side === OrderSide.BUY
        ? portfolio.totalNotional + orderNotional
        : portfolio.totalNotional; // sells reduce notional, so no breach on sells

    if (projectedTotal > maxPortfolioNotional) {
      breaches.push({
        limit: 'portfolio-total-notional',
        current: projectedTotal,
        maximum: maxPortfolioNotional,
      });
    }
  }

  private checkShortSellingRules(
    action: PlaceOrderAction,
    portfolio: PortfolioSnapshot,
    breaches: LimitBreach[],
  ): void {
    if (action.side !== OrderSide.SELL) {
      return;
    }

    const currentQty = this.getCurrentQuantity(action.instrument, portfolio);

    // If selling more than held, this creates or increases a short position
    if (action.quantity > currentQty) {
      const shortAmount = action.quantity - currentQty;
      breaches.push({
        limit: `short-sell-blocked:${action.instrument}`,
        current: shortAmount,
        maximum: 0,
      });
    }
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

  private getCurrentNotional(
    instrument: string,
    portfolio: PortfolioSnapshot,
  ): number {
    const position = portfolio.positions.find(
      (p) => p.instrument === instrument,
    );
    return position?.notionalValue ?? 0;
  }

  private getEstimatedPrice(
    action: PlaceOrderAction,
    portfolio: PortfolioSnapshot,
  ): number {
    // Prefer the limit price from the order, fall back to current market price
    if (action.price !== undefined && action.price > 0) {
      return action.price;
    }

    const position = portfolio.positions.find(
      (p) => p.instrument === action.instrument,
    );
    return position?.currentPrice ?? 0;
  }
}
