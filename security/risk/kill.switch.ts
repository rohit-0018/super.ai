import { randomUUID } from 'node:crypto';
import type { SecurityConfig } from '../types/config.js';
import { SecurityEventType, RiskLevel } from '../types/events.js';
import type { RedisAdapter, Logger, AlertBus } from './circuit.breaker.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type KillSwitchScope =
  | { type: 'USER'; userId: string }
  | { type: 'STRATEGY'; strategyId: string }
  | { type: 'GLOBAL' };

interface KillSwitchState {
  active: boolean;
  reason: string;
  triggeredBy: string;
  triggeredAt: string;
}

// ─── Express types (minimal to avoid importing express) ─────────────────────

interface ExpressRequest {
  headers: Record<string, string | string[] | undefined>;
}

interface ExpressResponse {
  status(code: number): ExpressResponse;
  json(body: Record<string, unknown>): void;
}

type NextFunction = () => void;

// ─── Redis key helpers ──────────────────────────────────────────────────────

const KEY_PREFIX = 'killswitch:';

function scopeKey(scope: KillSwitchScope): string {
  switch (scope.type) {
    case 'GLOBAL':
      return `${KEY_PREFIX}global`;
    case 'USER':
      return `${KEY_PREFIX}user:${scope.userId}`;
    case 'STRATEGY':
      return `${KEY_PREFIX}strategy:${scope.strategyId}`;
  }
}

// ─── KillSwitch ─────────────────────────────────────────────────────────────

export class KillSwitch {
  private readonly config: SecurityConfig;
  private readonly logger: Logger;
  private readonly alertBus: AlertBus;
  private readonly redis: RedisAdapter;

  constructor(
    config: SecurityConfig,
    logger: Logger,
    alertBus: AlertBus,
    redisAdapter: RedisAdapter,
  ) {
    this.config = config;
    this.logger = logger;
    this.alertBus = alertBus;
    this.redis = redisAdapter;
  }

  public async trigger(
    scope: KillSwitchScope,
    reason: string,
    triggeredBy: string,
  ): Promise<void> {
    const state: KillSwitchState = {
      active: true,
      reason,
      triggeredBy,
      triggeredAt: new Date().toISOString(),
    };

    const key = scopeKey(scope);
    await this.redis.set(key, JSON.stringify(state));

    const correlationId = randomUUID();
    this.logger.error(`Kill switch triggered [${scope.type}]: ${reason}`, {
      scope,
      reason,
      triggeredBy,
      correlationId,
    });

    this.alertBus.emit({
      level: RiskLevel.CRITICAL,
      type: SecurityEventType.KILL_SWITCH_TRIGGERED,
      message: `Kill switch triggered for ${this.scopeDescription(scope)}: ${reason}`,
      correlationId,
      metadata: {
        triggeredBy,
        reason,
        scopeType: scope.type,
      },
    });
  }

  public async isActive(scope: KillSwitchScope): Promise<boolean> {
    // Always check GLOBAL first
    const globalRaw = await this.redis.get(scopeKey({ type: 'GLOBAL' }));
    if (globalRaw !== null) {
      const globalState = JSON.parse(globalRaw) as KillSwitchState;
      if (globalState.active) {
        return true;
      }
    }

    // If scope is GLOBAL, we already checked
    if (scope.type === 'GLOBAL') {
      return false;
    }

    const raw = await this.redis.get(scopeKey(scope));
    if (raw === null) {
      return false;
    }

    const state = JSON.parse(raw) as KillSwitchState;
    return state.active;
  }

  public async reset(scope: KillSwitchScope, resetBy: string): Promise<void> {
    if (resetBy !== this.config.adminUserId) {
      throw new Error(
        `Unauthorized kill switch reset attempt by ${resetBy}. Only admin ${this.config.adminUserId} can reset.`,
      );
    }

    const key = scopeKey(scope);
    await this.redis.del(key);

    const correlationId = randomUUID();
    this.logger.info(`Kill switch reset [${scope.type}] by ${resetBy}`, {
      scope,
      resetBy,
      correlationId,
    });

    this.alertBus.emit({
      level: RiskLevel.MEDIUM,
      type: SecurityEventType.KILL_SWITCH_RESET,
      message: `Kill switch reset for ${this.scopeDescription(scope)} by ${resetBy}`,
      correlationId,
      metadata: {
        resetBy,
        reason: `Reset by admin ${resetBy}`,
      },
    });
  }

  public middleware(): (
    req: ExpressRequest,
    res: ExpressResponse,
    next: NextFunction,
  ) => Promise<void> {
    return async (
      req: ExpressRequest,
      res: ExpressResponse,
      next: NextFunction,
    ): Promise<void> => {
      const globalActive = await this.isActive({ type: 'GLOBAL' });
      if (globalActive) {
        res.status(503).json({
          error: 'KILL_SWITCH_ACTIVE',
          message: 'Trading is currently halted by the kill switch',
        });
        return;
      }

      // Check user-scoped kill switch if user ID is in headers
      const userIdHeader = req.headers['x-user-id'];
      const userId = Array.isArray(userIdHeader)
        ? userIdHeader[0]
        : userIdHeader;

      if (userId) {
        const userActive = await this.isActive({ type: 'USER', userId });
        if (userActive) {
          res.status(503).json({
            error: 'KILL_SWITCH_ACTIVE',
            message: `Trading is halted for user ${userId}`,
          });
          return;
        }
      }

      // Check strategy-scoped kill switch if strategy ID is in headers
      const strategyIdHeader = req.headers['x-strategy-id'];
      const strategyId = Array.isArray(strategyIdHeader)
        ? strategyIdHeader[0]
        : strategyIdHeader;

      if (strategyId) {
        const strategyActive = await this.isActive({
          type: 'STRATEGY',
          strategyId,
        });
        if (strategyActive) {
          res.status(503).json({
            error: 'KILL_SWITCH_ACTIVE',
            message: `Trading is halted for strategy ${strategyId}`,
          });
          return;
        }
      }

      next();
    };
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private scopeDescription(scope: KillSwitchScope): string {
    switch (scope.type) {
      case 'GLOBAL':
        return 'global';
      case 'USER':
        return `user ${scope.userId}`;
      case 'STRATEGY':
        return `strategy ${scope.strategyId}`;
    }
  }
}
