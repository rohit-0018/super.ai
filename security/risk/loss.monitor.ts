import { randomUUID } from 'node:crypto';
import type { SecurityConfig } from '../types/config.js';
import { SecurityEventType, RiskLevel } from '../types/events.js';
import type { PortfolioSnapshot } from '../types/risk.js';
import type { RedisAdapter, Logger, AlertBus } from './circuit.breaker.js';
import { KillSwitch } from './kill.switch.js';

// ─── Redis key helpers ──────────────────────────────────────────────────────

const HWM_PREFIX = 'loss:hwm:';
const DRAWDOWN_PREFIX = 'loss:drawdown:';

function hwmKey(userId: string): string {
  return `${HWM_PREFIX}${userId}`;
}

function drawdownKey(userId: string): string {
  return `${DRAWDOWN_PREFIX}${userId}`;
}

// ─── LossMonitor ────────────────────────────────────────────────────────────

export class LossMonitor {
  private readonly config: SecurityConfig;
  private readonly logger: Logger;
  private readonly killSwitch: KillSwitch;
  private readonly redis: RedisAdapter;
  private readonly alertBus: AlertBus;

  constructor(
    config: SecurityConfig,
    logger: Logger,
    alertBus: AlertBus,
    killSwitch: KillSwitch,
    redisAdapter: RedisAdapter,
  ) {
    this.config = config;
    this.logger = logger;
    this.alertBus = alertBus;
    this.killSwitch = killSwitch;
    this.redis = redisAdapter;
  }

  public async update(
    portfolio: PortfolioSnapshot,
    userId: string,
    strategyId: string,
  ): Promise<void> {
    const currentValue = portfolio.totalNotional + portfolio.totalUnrealizedPnl;

    // Get or initialize high watermark
    const storedHwm = await this.redis.get(hwmKey(userId));

    if (storedHwm === null) {
      // First update: initialize the high watermark
      await this.redis.set(hwmKey(userId), String(currentValue));
      await this.redis.set(drawdownKey(userId), '0');
      return;
    }

    const highWatermark = Number(storedHwm);

    // Update high watermark if current value exceeds stored
    if (currentValue > highWatermark) {
      await this.redis.set(hwmKey(userId), String(currentValue));
      await this.redis.set(drawdownKey(userId), '0');
      return;
    }

    // Compute drawdown percentage
    const drawdownPercent =
      highWatermark > 0
        ? ((highWatermark - currentValue) / highWatermark) * 100
        : 0;

    // Persist current drawdown
    await this.redis.set(drawdownKey(userId), String(drawdownPercent));

    this.logger.info(`Drawdown for user ${userId}: ${drawdownPercent.toFixed(2)}%`, {
      userId,
      strategyId,
      drawdownPercent,
      highWatermark,
      currentValue,
    });

    // Check if drawdown exceeds kill switch threshold
    const threshold = this.config.sessionDrawdownKillSwitchPercent;
    if (drawdownPercent >= threshold) {
      const correlationId = randomUUID();
      this.logger.error(
        `Loss limit breached for user ${userId}: drawdown ${drawdownPercent.toFixed(2)}% >= ${threshold}%`,
        {
          userId,
          strategyId,
          drawdownPercent,
          threshold,
          correlationId,
        },
      );

      this.alertBus.emit({
        level: RiskLevel.CRITICAL,
        type: SecurityEventType.LOSS_LIMIT_BREACHED,
        message: `Drawdown ${drawdownPercent.toFixed(2)}% exceeded kill switch threshold ${threshold}%`,
        correlationId,
        metadata: {
          strategyId,
          currentDrawdownPercent: drawdownPercent,
          limitPercent: threshold,
          unrealizedPnl: portfolio.totalUnrealizedPnl,
        },
      });

      await this.killSwitch.trigger(
        { type: 'USER', userId },
        `Drawdown ${drawdownPercent.toFixed(2)}% exceeded threshold ${threshold}%`,
        'loss-monitor',
      );
    }
  }

  public async getDrawdown(userId: string): Promise<number> {
    const stored = await this.redis.get(drawdownKey(userId));
    if (stored === null) {
      return 0;
    }
    return Number(stored);
  }

  public async resetWatermark(userId: string): Promise<void> {
    await this.redis.del(hwmKey(userId));
    await this.redis.del(drawdownKey(userId));

    this.logger.info(`High watermark reset for user ${userId}`, { userId });
  }
}
