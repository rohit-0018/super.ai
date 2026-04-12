// ─── Action Allowlist ───────────────────────────────────────────────────────

import { z } from 'zod';
import {
  AgentActionType,
  AgentActionSchema,
  PlaceOrderActionSchema,
  CancelOrderActionSchema,
  ModifyOrderActionSchema,
  ClosePositionActionSchema,
  RequestHumanReviewActionSchema,
  NoActionSchema,
  type AgentAction,
} from '../types/actions.js';
import { ActionBlockedError, SecurityErrorCode } from '../types/errors.js';
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

// ─── Raw LLM output schema (pre-validation) ────────────────────────────────

const RawLlmOutputSchema = z.object({
  type: z.string(),
}).passthrough();

// ─── Allow-list entry ───────────────────────────────────────────────────────

interface AllowlistEntry {
  readonly schema: z.ZodTypeAny;
  readonly requiresConfirmation: boolean;
}

// ─── Allow-list definition ──────────────────────────────────────────────────

const ALLOWLIST: Readonly<Record<AgentActionType, AllowlistEntry>> = {
  [AgentActionType.PlaceOrder]: {
    schema: PlaceOrderActionSchema,
    requiresConfirmation: true,
  },
  [AgentActionType.CancelOrder]: {
    schema: CancelOrderActionSchema,
    requiresConfirmation: false,
  },
  [AgentActionType.ModifyOrder]: {
    schema: ModifyOrderActionSchema,
    requiresConfirmation: true,
  },
  [AgentActionType.ClosePosition]: {
    schema: ClosePositionActionSchema,
    requiresConfirmation: true,
  },
  [AgentActionType.RequestHumanReview]: {
    schema: RequestHumanReviewActionSchema,
    requiresConfirmation: false,
  },
  [AgentActionType.NoAction]: {
    schema: NoActionSchema,
    requiresConfirmation: false,
  },
} as const;

// ─── ActionAllowlist class ──────────────────────────────────────────────────

export class ActionAllowlist {
  private readonly logger: Logger;
  private readonly emitter: EventEmitter | undefined;

  constructor(deps: { logger: Logger; emitter?: EventEmitter }) {
    this.logger = deps.logger;
    this.emitter = deps.emitter;
  }

  /**
   * Parse raw LLM output, identify action type, validate against allow-list.
   * Throws ActionBlockedError if action type is not in allow-list.
   */
  public validate(raw: unknown): AgentAction {
    // Step 1: Minimal parse to extract the action type
    const rawParsed = RawLlmOutputSchema.safeParse(raw);

    if (!rawParsed.success) {
      throw new ActionBlockedError(
        'LLM output is not a valid object with a type field',
        crypto.randomUUID(),
        SecurityErrorCode.ACTION_SANITY_CHECK_FAILED,
        { raw: String(raw) },
      );
    }

    const actionType = rawParsed.data.type;

    // Step 2: Check if the action type is in the allow-list
    if (!this.isAllowedActionType(actionType)) {
      this.logger.error('Action type not in allow-list', { actionType });

      this.emitter?.emit(SecurityEventType.ACTION_BLOCKED, {
        actionType,
        strategyId: 'unknown',
        reason: `Action type '${actionType}' is not in the allow-list`,
        violatedRule: 'action-allowlist',
      });

      throw new ActionBlockedError(
        `Action type '${actionType}' is not in the allow-list`,
        crypto.randomUUID(),
        SecurityErrorCode.ACTION_SANITY_CHECK_FAILED,
        { actionType },
      );
    }

    // Step 3: Validate against the discriminated union schema
    const parsed = AgentActionSchema.safeParse(raw);

    if (!parsed.success) {
      const errors = parsed.error.issues.map((i) => i.message).join('; ');

      this.logger.error('Action validation failed', {
        actionType,
        errors,
      });

      throw new ActionBlockedError(
        `Action validation failed: ${errors}`,
        crypto.randomUUID(),
        SecurityErrorCode.ACTION_SANITY_CHECK_FAILED,
        { actionType, zodErrors: parsed.error.issues },
      );
    }

    this.logger.info('Action validated against allow-list', {
      actionType: parsed.data.type,
    });

    return parsed.data;
  }

  /**
   * Returns whether the given action requires human confirmation.
   */
  public requiresConfirmation(action: AgentAction): boolean {
    const entry = ALLOWLIST[action.type];
    return entry.requiresConfirmation;
  }

  // ─── Private helpers ────────────────────────────────────────────────────

  private isAllowedActionType(type: string): type is AgentActionType {
    return Object.values(AgentActionType).includes(type as AgentActionType);
  }
}
