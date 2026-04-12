// ─── Sanity Checker ─────────────────────────────────────────────────────────

import { z } from 'zod';
import { AgentActionType, type AgentAction, type PlaceOrderAction, type CancelOrderAction, type ModifyOrderAction } from '../types/actions.js';
import type { PortfolioSnapshot } from '../types/risk.js';
import { SecurityEventType } from '../types/events.js';

// ─── Minimal interfaces for dependency injection ────────────────────────────

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface EventEmitter {
  emit(event: SecurityEventType, payload: Record<string, unknown>): void;
}

export interface MarketDataService {
  getCurrentPrice(instrument: string): Promise<number>;
}

// ─── Result type ────────────────────────────────────────────────────────────

export interface SanityCheckResult {
  readonly passed: boolean;
  readonly failures: ReadonlyArray<string>;
}

// ─── Configuration subset ───────────────────────────────────────────────────

export interface SanityCheckerConfig {
  readonly approvedTradingUniverse: ReadonlyArray<string>;
  readonly positionLimitsPerInstrument: Readonly<Record<string, number>>;
  readonly portfolioNotionalLimit: number;
  readonly feedConsensusDivergenceThresholdPercent: number;
}

// ─── SanityChecker class ────────────────────────────────────────────────────

export class SanityChecker {
  private readonly config: SanityCheckerConfig;
  private readonly logger: Logger;
  private readonly marketDataService: MarketDataService;
  private readonly emitter: EventEmitter | undefined;

  constructor(deps: {
    config: SanityCheckerConfig;
    logger: Logger;
    marketDataService: MarketDataService;
    emitter?: EventEmitter;
  }) {
    this.config = deps.config;
    this.logger = deps.logger;
    this.marketDataService = deps.marketDataService;
    this.emitter = deps.emitter;
  }

  /**
   * Run sanity checks on the given action in the context of the current portfolio.
   */
  public async check(action: AgentAction, portfolio: PortfolioSnapshot): Promise<SanityCheckResult> {
    const failures: string[] = [];

    switch (action.type) {
      case AgentActionType.PlaceOrder:
        await this.checkPlaceOrder(action, portfolio, failures);
        break;

      case AgentActionType.CancelOrder:
        this.checkCancelOrder(action, failures);
        break;

      case AgentActionType.ModifyOrder:
        this.checkModifyOrder(action, failures);
        break;

      case AgentActionType.ClosePosition:
      case AgentActionType.RequestHumanReview:
      case AgentActionType.NoAction:
        // No sanity checks for these action types
        break;
    }

    // Emit per-failure events
    for (const failure of failures) {
      this.emitter?.emit(SecurityEventType.SANITY_CHECK_FAILED, {
        actionType: action.type,
        strategyId: this.extractStrategyId(action),
        instrument: this.extractInstrument(action),
        field: 'sanity-check',
        value: 0,
        limit: 0,
        reason: failure,
      });
    }

    const result: SanityCheckResult = {
      passed: failures.length === 0,
      failures,
    };

    if (!result.passed) {
      this.logger.warn('Sanity check failed', {
        actionType: action.type,
        failures,
      });
    } else {
      this.logger.info('Sanity check passed', {
        actionType: action.type,
      });
    }

    return result;
  }

  // ─── PlaceOrder checks ──────────────────────────────────────────────────

  private async checkPlaceOrder(
    action: PlaceOrderAction,
    portfolio: PortfolioSnapshot,
    failures: string[],
  ): Promise<void> {
    // 1. Instrument in approved universe
    if (
      this.config.approvedTradingUniverse.length > 0 &&
      !this.config.approvedTradingUniverse.includes(action.instrument)
    ) {
      failures.push(`Instrument '${action.instrument}' is not in the approved trading universe`);
    }

    // 2. Order size <= per-instrument limit
    const instrumentLimit = this.config.positionLimitsPerInstrument[action.instrument];
    if (instrumentLimit !== undefined && action.quantity > instrumentLimit) {
      failures.push(
        `Order quantity ${action.quantity} exceeds per-instrument limit of ${instrumentLimit} for '${action.instrument}'`,
      );
    }

    // 3. Limit order price within tolerance of current mid-price
    if (action.price !== undefined) {
      try {
        const midPrice = await this.marketDataService.getCurrentPrice(action.instrument);
        const tolerancePercent = this.config.feedConsensusDivergenceThresholdPercent;
        const toleranceFraction = tolerancePercent / 100;
        const lowerBound = midPrice * (1 - toleranceFraction);
        const upperBound = midPrice * (1 + toleranceFraction);

        if (action.price < lowerBound || action.price > upperBound) {
          failures.push(
            `Limit price ${action.price} is outside ${tolerancePercent}% tolerance of mid-price ${midPrice} (bounds: ${lowerBound.toFixed(2)}-${upperBound.toFixed(2)})`,
          );
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push(`Failed to fetch current price for '${action.instrument}': ${message}`);
      }
    }

    // 4. Portfolio notional won't exceed max
    const orderNotional = action.quantity * (action.price ?? await this.getPrice(action.instrument));
    const projectedNotional = portfolio.totalNotional + orderNotional;

    if (projectedNotional > this.config.portfolioNotionalLimit) {
      failures.push(
        `Projected portfolio notional ${projectedNotional.toFixed(2)} would exceed limit of ${this.config.portfolioNotionalLimit}`,
      );
    }

    // 5. Order currency matches base (instrument must contain a recognized base)
    // Validate instrument format: must contain a separator indicating a pair
    if (!action.instrument.includes('-') && !action.instrument.includes('/')) {
      failures.push(
        `Instrument '${action.instrument}' does not match expected pair format (e.g., BTC-USDT)`,
      );
    }
  }

  // ─── CancelOrder checks ────────────────────────────────────────────────

  private checkCancelOrder(action: CancelOrderAction, failures: string[]): void {
    if (!this.isValidUuid(action.clientOrderId)) {
      failures.push(`Invalid clientOrderId: '${action.clientOrderId}' is not a valid UUID`);
    }
  }

  // ─── ModifyOrder checks ────────────────────────────────────────────────

  private checkModifyOrder(action: ModifyOrderAction, failures: string[]): void {
    if (!this.isValidUuid(action.clientOrderId)) {
      failures.push(`Invalid clientOrderId: '${action.clientOrderId}' is not a valid UUID`);
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private isValidUuid(value: string): boolean {
    return z.string().uuid().safeParse(value).success;
  }

  private async getPrice(instrument: string): Promise<number> {
    try {
      return await this.marketDataService.getCurrentPrice(instrument);
    } catch {
      return 0;
    }
  }

  private extractStrategyId(action: AgentAction): string {
    if ('strategyId' in action && typeof action.strategyId === 'string') {
      return action.strategyId;
    }
    return 'unknown';
  }

  private extractInstrument(action: AgentAction): string {
    if ('instrument' in action && typeof action.instrument === 'string') {
      return action.instrument;
    }
    return 'unknown';
  }
}
