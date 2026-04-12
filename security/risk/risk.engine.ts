import { randomUUID } from 'node:crypto';
import type { SecurityConfig } from '../types/config.js';
import { SecurityEventType, RiskLevel } from '../types/events.js';
import type { AgentAction, PlaceOrderAction } from '../types/actions.js';
import { AgentActionType } from '../types/actions.js';
import type { PortfolioSnapshot } from '../types/risk.js';
import type { Logger, AlertBus } from './circuit.breaker.js';
import { CircuitBreaker } from './circuit.breaker.js';
import { KillSwitch } from './kill.switch.js';
import type { KillSwitchScope } from './kill.switch.js';
import { PositionLimitsChecker } from './position.limits.js';
import { LossMonitor } from './loss.monitor.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RiskContext {
  userId: string;
  strategyId: string;
  portfolio: PortfolioSnapshot;
  sessionId: string;
}

export interface RiskEvaluation {
  approved: boolean;
  riskLevel: RiskLevel;
  blockReasons: string[];
}

// ─── RiskEngine ─────────────────────────────────────────────────────────────

export class RiskEngine {
  private readonly logger: Logger;
  private readonly alertBus: AlertBus;
  private readonly killSwitch: KillSwitch;
  private readonly positionLimitsChecker: PositionLimitsChecker;
  private readonly lossMonitor: LossMonitor;
  private readonly velocityBreaker: CircuitBreaker;
  private readonly errorRateBreaker: CircuitBreaker;
  private readonly lossBreaker: CircuitBreaker;

  constructor(
    _config: SecurityConfig,
    logger: Logger,
    alertBus: AlertBus,
    killSwitch: KillSwitch,
    positionLimitsChecker: PositionLimitsChecker,
    lossMonitor: LossMonitor,
    velocityBreaker: CircuitBreaker,
    errorRateBreaker: CircuitBreaker,
    lossBreaker: CircuitBreaker,
  ) {
    this.logger = logger;
    this.alertBus = alertBus;
    this.killSwitch = killSwitch;
    this.positionLimitsChecker = positionLimitsChecker;
    this.lossMonitor = lossMonitor;
    this.velocityBreaker = velocityBreaker;
    this.errorRateBreaker = errorRateBreaker;
    this.lossBreaker = lossBreaker;
  }

  public async evaluate(
    action: AgentAction,
    context: RiskContext,
  ): Promise<RiskEvaluation> {
    const blockReasons: string[] = [];
    let highestRisk = RiskLevel.LOW;

    // 1. Check kill switch first (most severe)
    const killSwitchActive = await this.checkKillSwitch(context);
    if (killSwitchActive) {
      blockReasons.push('Kill switch is active');
      highestRisk = RiskLevel.CRITICAL;
    }

    // 2. Check circuit breakers
    const breakerReasons = await this.checkCircuitBreakers();
    if (breakerReasons.length > 0) {
      blockReasons.push(...breakerReasons);
      highestRisk = this.elevateRisk(highestRisk, RiskLevel.HIGH);
    }

    // 3. For order actions, run position limits check
    if (action.type === AgentActionType.PlaceOrder) {
      const limitsResult = await this.positionLimitsChecker.check(
        action as PlaceOrderAction,
        context.portfolio,
      );
      if (!limitsResult.passed) {
        for (const breach of limitsResult.breaches) {
          blockReasons.push(
            `Position limit breached: ${breach.limit} (current: ${breach.current}, max: ${breach.maximum})`,
          );
        }
        highestRisk = this.elevateRisk(highestRisk, RiskLevel.HIGH);
      }
    }

    // 4. Update loss monitor (non-blocking for the decision but may trigger kill switch)
    await this.lossMonitor.update(
      context.portfolio,
      context.userId,
      context.strategyId,
    );

    // 5. Compute overall risk level based on action type
    if (blockReasons.length === 0) {
      highestRisk = this.computeBaseRiskLevel(action);
    }

    const approved = blockReasons.length === 0;
    const correlationId = randomUUID();

    if (approved) {
      this.alertBus.emit({
        level: highestRisk,
        type: SecurityEventType.ACTION_ALLOWED,
        message: `Action ${action.type} approved for user ${context.userId}`,
        correlationId,
        metadata: {
          actionType: action.type,
          strategyId: context.strategyId,
          checksPerformed: [
            'kill-switch',
            'circuit-breakers',
            'position-limits',
            'loss-monitor',
          ],
        },
      });
    } else {
      this.logger.warn(`Action ${action.type} blocked: ${blockReasons.join('; ')}`, {
        userId: context.userId,
        strategyId: context.strategyId,
        blockReasons,
        correlationId,
      });

      this.alertBus.emit({
        level: highestRisk,
        type: SecurityEventType.ACTION_BLOCKED,
        message: `Action ${action.type} blocked: ${blockReasons[0] ?? 'unknown'}`,
        correlationId,
        metadata: {
          actionType: action.type,
          strategyId: context.strategyId,
          reason: blockReasons.join('; '),
          violatedRule: blockReasons[0] ?? 'unknown',
        },
      });
    }

    return {
      approved,
      riskLevel: highestRisk,
      blockReasons,
    };
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async checkKillSwitch(context: RiskContext): Promise<boolean> {
    const scopes: KillSwitchScope[] = [
      { type: 'GLOBAL' },
      { type: 'USER', userId: context.userId },
      { type: 'STRATEGY', strategyId: context.strategyId },
    ];

    for (const scope of scopes) {
      const active = await this.killSwitch.isActive(scope);
      if (active) {
        return true;
      }
    }

    return false;
  }

  private async checkCircuitBreakers(): Promise<string[]> {
    const reasons: string[] = [];

    if (await this.velocityBreaker.isOpen()) {
      reasons.push('Velocity circuit breaker is open');
    }

    if (await this.errorRateBreaker.isOpen()) {
      reasons.push('Error rate circuit breaker is open');
    }

    if (await this.lossBreaker.isOpen()) {
      reasons.push('Loss circuit breaker is open');
    }

    return reasons;
  }

  private computeBaseRiskLevel(action: AgentAction): RiskLevel {
    switch (action.type) {
      case AgentActionType.PlaceOrder:
        return RiskLevel.MEDIUM;
      case AgentActionType.CancelOrder:
        return RiskLevel.LOW;
      case AgentActionType.ModifyOrder:
        return RiskLevel.MEDIUM;
      case AgentActionType.ClosePosition:
        return RiskLevel.MEDIUM;
      case AgentActionType.RequestHumanReview:
        return RiskLevel.LOW;
      case AgentActionType.NoAction:
        return RiskLevel.LOW;
    }
  }

  private elevateRisk(current: RiskLevel, candidate: RiskLevel): RiskLevel {
    const order: Record<RiskLevel, number> = {
      [RiskLevel.LOW]: 0,
      [RiskLevel.MEDIUM]: 1,
      [RiskLevel.HIGH]: 2,
      [RiskLevel.CRITICAL]: 3,
    };

    return order[candidate] > order[current] ? candidate : current;
  }
}
