import { randomUUID } from 'node:crypto';
import { CircuitBreakerState } from '../types/risk.js';
import { SecurityEventType, RiskLevel } from '../types/events.js';

// ─── Interfaces ─────────────────────────────────────────────────────────────

export interface RedisAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  setex(key: string, ttlSeconds: number, value: string): Promise<void>;
  del(key: string): Promise<void>;
  incr(key: string): Promise<number>;
  expire(key: string, ttlSeconds: number): Promise<void>;
  ttl(key: string): Promise<number>;
}

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

// ─── Redis key helpers ──────────────────────────────────────────────────────

const KEY_PREFIX = 'cb:';

function stateKey(name: string): string {
  return `${KEY_PREFIX}${name}:state`;
}

function failCountKey(name: string): string {
  return `${KEY_PREFIX}${name}:failures`;
}

function openedAtKey(name: string): string {
  return `${KEY_PREFIX}${name}:openedAt`;
}

// ─── CircuitBreaker ─────────────────────────────────────────────────────────

export class CircuitBreaker {
  private readonly name: string;
  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly resetTimeoutMs: number;
  private readonly logger: Logger;
  private readonly alertBus: AlertBus;
  private readonly redis: RedisAdapter;

  constructor(
    name: string,
    threshold: number,
    windowMs: number,
    resetTimeoutMs: number,
    logger: Logger,
    alertBus: AlertBus,
    redisAdapter: RedisAdapter,
  ) {
    this.name = name;
    this.threshold = threshold;
    this.windowMs = windowMs;
    this.resetTimeoutMs = resetTimeoutMs;
    this.logger = logger;
    this.alertBus = alertBus;
    this.redis = redisAdapter;
  }

  public async recordSuccess(): Promise<void> {
    const state = await this.getState();

    if (state === CircuitBreakerState.HALF_OPEN) {
      // Successful probe in HALF_OPEN -> transition to CLOSED
      await this.transitionTo(CircuitBreakerState.CLOSED);
      await this.redis.del(failCountKey(this.name));
      await this.redis.del(openedAtKey(this.name));

      const correlationId = randomUUID();
      this.logger.info(`Circuit breaker ${this.name} closed after successful probe`, {
        breakerName: this.name,
        correlationId,
      });
      this.alertBus.emit({
        level: RiskLevel.LOW,
        type: SecurityEventType.CIRCUIT_BREAKER_CLOSED,
        message: `Circuit breaker ${this.name} recovered and closed`,
        correlationId,
        metadata: {
          breakerName: this.name,
          recoveryDurationMs: 0,
        },
      });
    } else if (state === CircuitBreakerState.CLOSED) {
      // In CLOSED state, a success is a no-op for the failure counter
      // (rolling window expiry handles cleanup)
    }
  }

  public async recordFailure(): Promise<void> {
    const state = await this.getState();

    if (state === CircuitBreakerState.OPEN) {
      // Already open, nothing to do
      return;
    }

    if (state === CircuitBreakerState.HALF_OPEN) {
      // Failure in HALF_OPEN -> back to OPEN
      await this.openBreaker('Failure during half-open probe');
      return;
    }

    // CLOSED state: increment rolling failure count
    const count = await this.redis.incr(failCountKey(this.name));
    if (count === 1) {
      // First failure in the window: set the TTL
      const windowSeconds = Math.ceil(this.windowMs / 1000);
      await this.redis.expire(failCountKey(this.name), windowSeconds);
    }

    if (count >= this.threshold) {
      await this.openBreaker(
        `Failure count ${count} reached threshold ${this.threshold} within ${this.windowMs}ms window`,
      );
    }
  }

  public async getState(): Promise<CircuitBreakerState> {
    const stored = await this.redis.get(stateKey(this.name));

    if (stored === CircuitBreakerState.OPEN) {
      // Check if reset timeout has elapsed
      const openedAtStr = await this.redis.get(openedAtKey(this.name));
      if (openedAtStr !== null) {
        const elapsed = Date.now() - Number(openedAtStr);
        if (elapsed >= this.resetTimeoutMs) {
          // Transition to HALF_OPEN
          await this.transitionTo(CircuitBreakerState.HALF_OPEN);

          const correlationId = randomUUID();
          this.logger.info(`Circuit breaker ${this.name} transitioned to HALF_OPEN`, {
            breakerName: this.name,
            correlationId,
          });
          this.alertBus.emit({
            level: RiskLevel.MEDIUM,
            type: SecurityEventType.CIRCUIT_BREAKER_HALF_OPEN,
            message: `Circuit breaker ${this.name} is now half-open, allowing probe`,
            correlationId,
            metadata: {
              breakerName: this.name,
              testAction: 'probe',
            },
          });

          return CircuitBreakerState.HALF_OPEN;
        }
      }
      return CircuitBreakerState.OPEN;
    }

    if (stored === CircuitBreakerState.HALF_OPEN) {
      return CircuitBreakerState.HALF_OPEN;
    }

    // Default to CLOSED if no state stored
    return CircuitBreakerState.CLOSED;
  }

  public async isOpen(): Promise<boolean> {
    const state = await this.getState();
    return state === CircuitBreakerState.OPEN;
  }

  public async forceOpen(reason: string): Promise<void> {
    await this.openBreaker(`Force open: ${reason}`);
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private async openBreaker(reason: string): Promise<void> {
    await this.transitionTo(CircuitBreakerState.OPEN);
    await this.redis.set(openedAtKey(this.name), String(Date.now()));
    await this.redis.del(failCountKey(this.name));

    const correlationId = randomUUID();
    this.logger.warn(`Circuit breaker ${this.name} OPENED: ${reason}`, {
      breakerName: this.name,
      reason,
      correlationId,
    });
    this.alertBus.emit({
      level: RiskLevel.CRITICAL,
      type: SecurityEventType.CIRCUIT_BREAKER_OPEN,
      message: `Circuit breaker ${this.name} opened: ${reason}`,
      correlationId,
      metadata: {
        breakerName: this.name,
        reason,
        threshold: this.threshold,
        currentCount: this.threshold,
      },
    });
  }

  private async transitionTo(newState: CircuitBreakerState): Promise<void> {
    await this.redis.set(stateKey(this.name), newState);
  }
}
