// ─── Output Filter (Orchestrator) ───────────────────────────────────────────

import type { AgentAction } from '../types/actions.js';
import type { PortfolioSnapshot } from '../types/risk.js';
import { SecurityEventType } from '../types/events.js';
import { ActionBlockedError } from '../types/errors.js';
import { ActionAllowlist } from './action.allowlist.js';
import { SanityChecker } from './sanity.checker.js';
import { DuplicateDetector } from './duplicate.detector.js';

// ─── Minimal interfaces for dependency injection ────────────────────────────

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface EventEmitter {
  emit(event: SecurityEventType, payload: Record<string, unknown>): void;
}

// ─── Result type ────────────────────────────────────────────────────────────

export interface FilteredOutput {
  readonly action: AgentAction;
  readonly allowed: boolean;
  readonly confirmationRequired: boolean;
  readonly blockReasons: ReadonlyArray<string>;
}

// ─── OutputFilter class ─────────────────────────────────────────────────────

export class OutputFilter {
  private readonly allowlist: ActionAllowlist;
  private readonly sanityChecker: SanityChecker;
  private readonly duplicateDetector: DuplicateDetector;
  private readonly logger: Logger;
  private readonly emitter: EventEmitter | undefined;

  constructor(deps: {
    allowlist: ActionAllowlist;
    sanityChecker: SanityChecker;
    duplicateDetector: DuplicateDetector;
    logger: Logger;
    emitter?: EventEmitter;
  }) {
    this.allowlist = deps.allowlist;
    this.sanityChecker = deps.sanityChecker;
    this.duplicateDetector = deps.duplicateDetector;
    this.logger = deps.logger;
    this.emitter = deps.emitter;
  }

  /**
   * Full output filtering pipeline: parse -> sanity check -> dedup check.
   */
  public async process(rawLlmOutput: unknown, portfolio: PortfolioSnapshot): Promise<FilteredOutput> {
    const blockReasons: string[] = [];
    let action: AgentAction;

    // Step 1: Parse and validate against allow-list
    try {
      action = this.allowlist.validate(rawLlmOutput);
    } catch (err: unknown) {
      if (err instanceof ActionBlockedError) {
        this.logger.error('Action blocked at allowlist stage', {
          reason: err.message,
        });

        this.emitter?.emit(SecurityEventType.ACTION_BLOCKED, {
          actionType: 'unknown',
          strategyId: 'unknown',
          reason: err.message,
          violatedRule: 'action-allowlist',
        });

        // Re-throw: we cannot construct a FilteredOutput without a valid action
        throw err;
      }
      throw err;
    }

    // Step 2: Sanity checks
    const sanityResult = await this.sanityChecker.check(action, portfolio);
    if (!sanityResult.passed) {
      blockReasons.push(...sanityResult.failures);
    }

    // Step 3: Duplicate detection
    const dupResult = await this.duplicateDetector.check(action);
    if (dupResult.isDuplicate) {
      blockReasons.push(
        `Duplicate order detected (original: ${dupResult.originalOrderId ?? 'unknown'})`,
      );
    }

    // Step 4: Determine confirmation requirement
    const confirmationRequired = this.allowlist.requiresConfirmation(action);

    // Step 5: Determine allowed status
    const allowed = blockReasons.length === 0;

    // Step 6: Emit appropriate event
    const strategyId = this.extractStrategyId(action);
    const instrument = this.extractInstrument(action);

    if (allowed) {
      this.emitter?.emit(SecurityEventType.ACTION_ALLOWED, {
        actionType: action.type,
        strategyId,
        instrument,
        checksPerformed: ['allowlist', 'sanity', 'duplicate'],
      });

      this.logger.info('Action allowed', {
        actionType: action.type,
        strategyId,
        confirmationRequired,
      });
    } else {
      this.emitter?.emit(SecurityEventType.ACTION_BLOCKED, {
        actionType: action.type,
        strategyId,
        instrument,
        reason: blockReasons.join('; '),
        violatedRule: 'output-filter',
      });

      this.logger.warn('Action blocked', {
        actionType: action.type,
        strategyId,
        blockReasons,
      });
    }

    return {
      action,
      allowed,
      confirmationRequired,
      blockReasons,
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

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
