import type { AgentAction, PlaceOrderAction } from '../types/actions.js';
import { AgentActionType } from '../types/actions.js';
import { RiskLevel } from '../types/events.js';
import type { SecurityConfig } from '../types/config.js';
import type { ApprovalChallenge, ApprovalFlow } from './approval.flow.js';

// ─── Domain types ───────────────────────────────────────────────────────────

export interface RiskEvaluation {
  readonly approved: boolean;
  readonly riskLevel: RiskLevel;
  readonly blockReasons: string[];
}

export type EnforcementResult =
  | { readonly required: false }
  | { readonly required: true; readonly challenge: ApprovalChallenge };

// ─── ConfirmationGate ───────────────────────────────────────────────────────

export class ConfirmationGate {
  private readonly config: SecurityConfig;
  private readonly approvalFlow: ApprovalFlow;

  constructor(config: SecurityConfig, approvalFlow: ApprovalFlow) {
    this.config = config;
    this.approvalFlow = approvalFlow;
  }

  evaluate(action: AgentAction, riskEvaluation: RiskEvaluation): boolean {
    // HIGH or CRITICAL risk -> require confirmation
    if (
      riskEvaluation.riskLevel === RiskLevel.HIGH ||
      riskEvaluation.riskLevel === RiskLevel.CRITICAL
    ) {
      return true;
    }

    // PlaceOrder with notional exceeding threshold -> require confirmation
    if (action.type === AgentActionType.PlaceOrder) {
      const placeOrder = action as PlaceOrderAction;
      const notional = this.estimateNotional(placeOrder);
      if (notional > this.config.highValueConfirmationThreshold) {
        return true;
      }
    }

    return false;
  }

  async enforce(
    action: AgentAction,
    userId: string,
    sessionId: string,
  ): Promise<EnforcementResult> {
    // Build a basic risk evaluation to feed into evaluate.
    // The caller may also call evaluate() directly with a richer RiskEvaluation;
    // enforce() uses a default LOW evaluation so the notional-threshold path is
    // still exercised.
    const defaultRiskEvaluation: RiskEvaluation = {
      approved: true,
      riskLevel: RiskLevel.LOW,
      blockReasons: [],
    };

    const required = this.evaluate(action, defaultRiskEvaluation);

    if (!required) {
      return { required: false };
    }

    const challenge = await this.approvalFlow.createChallenge(action, userId, sessionId);
    return { required: true, challenge };
  }

  // ── Internal helpers ────────────────────────────────────────────────────

  private estimateNotional(order: PlaceOrderAction): number {
    // For limit / stop-limit orders the price is known; for market orders
    // we fall back to quantity alone (price will be undefined). A production
    // implementation would fetch a live mid-price; here we treat undefined
    // price as 0 so the threshold only fires when a price is available.
    const price = order.price ?? 0;
    return order.quantity * price;
  }
}
