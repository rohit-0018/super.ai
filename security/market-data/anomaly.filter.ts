import { randomUUID } from 'node:crypto';
import type { SecurityConfig } from '../types/config.js';
import { SecurityEventType, RiskLevel } from '../types/events.js';

// ─── Interfaces ─────────────────────────────────────────────────────────────

export interface AnomalyRedisAdapter {
  lpush(key: string, value: string): Promise<void>;
  ltrim(key: string, start: number, stop: number): Promise<void>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
}

export interface AnomalyLogger {
  log(event: {
    eventType: SecurityEventType;
    timestamp: string;
    correlationId: string;
    riskLevel: RiskLevel;
    payload: Record<string, unknown>;
  }): void;
}

// ─── Result type ────────────────────────────────────────────────────────────

export interface AnomalyFilterResult {
  anomalous: boolean;
  mean: number;
  stdDev: number;
  deviations: number;
}

// ─── Class ──────────────────────────────────────────────────────────────────

/**
 * Maintains a rolling window of recent prices in Redis. Computes mean and
 * standard deviation. If a new price deviates by more than
 * config.anomalyStdDevMultiplier * stdDev, flags it as anomalous and emits
 * FEED_ANOMALY_DETECTED.
 *
 * After the check, the new price is appended to the window and trimmed to
 * config.anomalyWindowSize.
 */
export class AnomalyFilter {
  private readonly config: SecurityConfig;
  private readonly logger: AnomalyLogger;
  private readonly redis: AnomalyRedisAdapter;

  constructor(
    config: SecurityConfig,
    logger: AnomalyLogger,
    redis: AnomalyRedisAdapter,
  ) {
    this.config = config;
    this.logger = logger;
    this.redis = redis;
  }

  public async check(
    instrument: string,
    price: number,
  ): Promise<AnomalyFilterResult> {
    const key = `feed:anomaly:${instrument}`;

    // Read existing window
    const raw = await this.redis.lrange(key, 0, -1);
    const window = raw.map(Number);

    let result: AnomalyFilterResult;

    if (window.length < 2) {
      // Not enough data for statistics
      result = {
        anomalous: false,
        mean: window.length === 1 ? window[0]! : price,
        stdDev: 0,
        deviations: 0,
      };
    } else {
      const mean = window.reduce((sum, v) => sum + v, 0) / window.length;
      const variance =
        window.reduce((sum, v) => sum + (v - mean) ** 2, 0) / window.length;
      const stdDev = Math.sqrt(variance);

      const deviations = stdDev === 0 ? 0 : Math.abs(price - mean) / stdDev;
      const anomalous = deviations > this.config.anomalyStdDevMultiplier;

      if (anomalous) {
        const correlationId = randomUUID();
        const low = mean - this.config.anomalyStdDevMultiplier * stdDev;
        const high = mean + this.config.anomalyStdDevMultiplier * stdDev;

        this.logger.log({
          eventType: SecurityEventType.FEED_ANOMALY_DETECTED,
          timestamp: new Date().toISOString(),
          correlationId,
          riskLevel: RiskLevel.HIGH,
          payload: {
            feedId: instrument,
            instrument,
            currentValue: price,
            expectedRange: { low, high },
            stdDevsAway: deviations,
          },
        });
      }

      result = { anomalous, mean, stdDev, deviations };
    }

    // Append new price to window and trim
    await this.redis.lpush(key, String(price));
    await this.redis.ltrim(key, 0, this.config.anomalyWindowSize - 1);

    return result;
  }
}
