import { randomUUID } from 'node:crypto';
import { SecurityEventType, RiskLevel } from '../types/events.js';

// ─── Dependency interfaces ──────────────────────────────────────────────────

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface RedisAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  setex(key: string, ttlSeconds: number, value: string): Promise<void>;
  del(key: string): Promise<void>;
}

export interface KillSwitchInterface {
  trigger(
    scope: { type: 'GLOBAL' },
    reason: string,
    triggeredBy: string,
  ): Promise<void>;
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

// ─── Config subset ──────────────────────────────────────────────────────────

export interface DeadMansSwitchConfig {
  deadManSwitchHeartbeatTimeoutSeconds: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const REDIS_HEARTBEAT_KEY = 'deadman:heartbeat';
const TRIGGERED_BY = 'DeadMansSwitch';

// ─── DeadMansSwitch ─────────────────────────────────────────────────────────

export class DeadMansSwitch {
  private readonly config: DeadMansSwitchConfig;
  private readonly logger: Logger;
  private readonly killSwitch: KillSwitchInterface;
  private readonly redisAdapter: RedisAdapter;
  private readonly alertBus: AlertBus;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeatAt: string | null = null;

  constructor(
    config: DeadMansSwitchConfig,
    logger: Logger,
    killSwitch: KillSwitchInterface,
    redisAdapter: RedisAdapter,
    alertBus: AlertBus,
  ) {
    this.config = config;
    this.logger = logger;
    this.killSwitch = killSwitch;
    this.redisAdapter = redisAdapter;
    this.alertBus = alertBus;
  }

  public async recordHeartbeat(): Promise<void> {
    const now = new Date().toISOString();
    const ttlSeconds = this.config.deadManSwitchHeartbeatTimeoutSeconds * 2;

    await this.redisAdapter.setex(REDIS_HEARTBEAT_KEY, ttlSeconds, now);
    this.lastHeartbeatAt = now;

    this.logger.info('Dead man switch heartbeat recorded', {
      timestamp: now,
      ttlSeconds,
    });
  }

  public start(): void {
    if (this.intervalHandle !== null) {
      this.logger.warn('DeadMansSwitch already started');
      return;
    }

    const checkIntervalMs = (this.config.deadManSwitchHeartbeatTimeoutSeconds / 2) * 1000;

    this.logger.info('Starting dead man switch', {
      timeoutSeconds: this.config.deadManSwitchHeartbeatTimeoutSeconds,
      checkIntervalMs,
    });

    this.intervalHandle = setInterval(() => {
      void this.checkHeartbeat();
    }, checkIntervalMs);
  }

  public stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      this.logger.info('Dead man switch stopped');
    }
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  private async checkHeartbeat(): Promise<void> {
    try {
      const heartbeatValue = await this.redisAdapter.get(REDIS_HEARTBEAT_KEY);

      if (heartbeatValue === null) {
        // Heartbeat key expired or was never set
        await this.triggerSwitch();
        return;
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Error checking dead man switch heartbeat', {
        error: errorMessage,
      });
    }
  }

  private async triggerSwitch(): Promise<void> {
    const now = new Date();
    const lastHeartbeat = this.lastHeartbeatAt ?? 'never';
    const elapsedSeconds = this.lastHeartbeatAt
      ? Math.round((now.getTime() - new Date(this.lastHeartbeatAt).getTime()) / 1000)
      : this.config.deadManSwitchHeartbeatTimeoutSeconds;

    this.logger.error('Dead man switch triggered - heartbeat expired', {
      lastHeartbeatAt: lastHeartbeat,
      timeoutSeconds: this.config.deadManSwitchHeartbeatTimeoutSeconds,
      elapsedSeconds,
    });

    const correlationId = randomUUID();
    this.alertBus.emit({
      level: RiskLevel.CRITICAL,
      type: SecurityEventType.DEAD_MANS_SWITCH_TRIGGERED,
      message: `Dead man switch triggered: no heartbeat for ${elapsedSeconds}s (timeout: ${this.config.deadManSwitchHeartbeatTimeoutSeconds}s)`,
      correlationId,
      metadata: {
        lastHeartbeatAt: lastHeartbeat,
        timeoutSeconds: this.config.deadManSwitchHeartbeatTimeoutSeconds,
        elapsedSeconds,
      },
    });

    await this.killSwitch.trigger(
      { type: 'GLOBAL' },
      `DEAD_MANS_SWITCH_TRIGGERED: no heartbeat for ${elapsedSeconds}s`,
      TRIGGERED_BY,
    );

    this.stop();
  }
}
