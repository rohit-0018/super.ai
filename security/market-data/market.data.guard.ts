import { randomUUID } from 'node:crypto';
import type { SecurityConfig } from '../types/config.js';
import { SecurityEventType, RiskLevel } from '../types/events.js';
import { FeedError, SecurityErrorCode } from '../types/errors.js';
import type { RawMarketDataPoint } from './feed.signature.verifier.js';
import { RawMarketDataPointSchema } from './feed.signature.verifier.js';
import type { FeedConsensus } from './feed.consensus.js';
import type { AnomalyFilter } from './anomaly.filter.js';
import type { FeedSignatureVerifier } from './feed.signature.verifier.js';

// ─── Interfaces ─────────────────────────────────────────────────────────────

export interface GuardRedisAdapter {
  lpush(key: string, value: string): Promise<void>;
  ltrim(key: string, start: number, stop: number): Promise<void>;
}

export interface GuardLogger {
  log(event: {
    eventType: SecurityEventType;
    timestamp: string;
    correlationId: string;
    riskLevel: RiskLevel;
    payload: Record<string, unknown>;
  }): void;
}

// ─── Validated output type ──────────────────────────────────────────────────

export interface ValidatedMarketDataPoint {
  instrument: string;
  price: number;
  volume: number;
  timestamp: string;
  source: string;
  validatedAt: string;
  correlationId: string;
}

// ─── Quarantine key ─────────────────────────────────────────────────────────

const QUARANTINE_KEY = 'feed:quarantine';
const QUARANTINE_MAX_LENGTH = 1000;

// ─── Class ──────────────────────────────────────────────────────────────────

/**
 * Orchestrates FeedConsensus, AnomalyFilter, and FeedSignatureVerifier to
 * validate incoming market data. Rejected data is quarantined to a Redis list.
 */
export class MarketDataGuard {
  private readonly logger: GuardLogger;
  private readonly redis: GuardRedisAdapter;
  private readonly feedConsensus: FeedConsensus;
  private readonly anomalyFilter: AnomalyFilter;
  private readonly signatureVerifier: FeedSignatureVerifier;

  constructor(
    _config: SecurityConfig,
    logger: GuardLogger,
    redis: GuardRedisAdapter,
    feedConsensus: FeedConsensus,
    anomalyFilter: AnomalyFilter,
    signatureVerifier: FeedSignatureVerifier,
  ) {
    this.logger = logger;
    this.redis = redis;
    this.feedConsensus = feedConsensus;
    this.anomalyFilter = anomalyFilter;
    this.signatureVerifier = signatureVerifier;
  }

  /**
   * Run all validators in sequence on the incoming data point.
   * On failure: quarantine to Redis, log, and throw FeedError.
   * On success: return validated data point.
   */
  public async validate(
    dataPoint: RawMarketDataPoint,
  ): Promise<ValidatedMarketDataPoint> {
    const correlationId = randomUUID();

    // 1. Validate schema
    const parsed = RawMarketDataPointSchema.safeParse(dataPoint);
    if (!parsed.success) {
      await this.quarantine(dataPoint, 'Schema validation failed', correlationId);
      throw new FeedError(
        `Schema validation failed: ${parsed.error.message}`,
        correlationId,
        SecurityErrorCode.FEED_ANOMALY_DETECTED,
        { source: dataPoint.source, instrument: dataPoint.instrument },
      );
    }

    // 2. Verify signature (may throw FeedError)
    try {
      await this.signatureVerifier.verify(dataPoint);
    } catch (err) {
      await this.quarantine(dataPoint, 'Signature verification failed', correlationId);
      throw err;
    }

    // 3. Check feed consensus
    const consensusResult = await this.feedConsensus.check(
      dataPoint.instrument,
      dataPoint.price,
      dataPoint.source,
    );

    if (!consensusResult.consensus) {
      await this.quarantine(dataPoint, 'Feed consensus failure', correlationId);
      throw new FeedError(
        `Feed consensus failure for ${dataPoint.instrument}: ${consensusResult.divergencePercent.toFixed(2)}% divergence`,
        correlationId,
        SecurityErrorCode.FEED_CONSENSUS_DIVERGED,
        {
          instrument: dataPoint.instrument,
          source: dataPoint.source,
          divergencePercent: consensusResult.divergencePercent,
        },
      );
    }

    // 4. Check anomaly
    const anomalyResult = await this.anomalyFilter.check(
      dataPoint.instrument,
      dataPoint.price,
    );

    if (anomalyResult.anomalous) {
      await this.quarantine(dataPoint, 'Anomaly detected', correlationId);
      throw new FeedError(
        `Anomaly detected for ${dataPoint.instrument}: ${anomalyResult.deviations.toFixed(2)} std devs away`,
        correlationId,
        SecurityErrorCode.FEED_ANOMALY_DETECTED,
        {
          instrument: dataPoint.instrument,
          source: dataPoint.source,
          deviations: anomalyResult.deviations,
          mean: anomalyResult.mean,
          stdDev: anomalyResult.stdDev,
        },
      );
    }

    // All checks passed
    return {
      instrument: dataPoint.instrument,
      price: dataPoint.price,
      volume: dataPoint.volume,
      timestamp: dataPoint.timestamp,
      source: dataPoint.source,
      validatedAt: new Date().toISOString(),
      correlationId,
    };
  }

  private async quarantine(
    dataPoint: RawMarketDataPoint,
    reason: string,
    correlationId: string,
  ): Promise<void> {
    const entry = JSON.stringify({
      dataPoint,
      reason,
      correlationId,
      quarantinedAt: new Date().toISOString(),
    });

    await this.redis.lpush(QUARANTINE_KEY, entry);
    await this.redis.ltrim(QUARANTINE_KEY, 0, QUARANTINE_MAX_LENGTH - 1);

    this.logger.log({
      eventType: SecurityEventType.FEED_ANOMALY_DETECTED,
      timestamp: new Date().toISOString(),
      correlationId,
      riskLevel: RiskLevel.HIGH,
      payload: {
        feedId: dataPoint.source,
        instrument: dataPoint.instrument,
        currentValue: dataPoint.price,
        expectedRange: { low: 0, high: 0 },
        stdDevsAway: 0,
        reason,
      },
    });
  }
}
