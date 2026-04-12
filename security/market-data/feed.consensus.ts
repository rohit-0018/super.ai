import { randomUUID } from 'node:crypto';
import type { SecurityConfig } from '../types/config.js';
import { SecurityEventType, RiskLevel } from '../types/events.js';

// ─── Interfaces ─────────────────────────────────────────────────────────────

export interface ConsensusRedisAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  setex(key: string, ttlSeconds: number, value: string): Promise<void>;
  del(key: string): Promise<void>;
  hset(key: string, field: string, value: string): Promise<void>;
  hget(key: string, field: string): Promise<string | null>;
  hgetall(key: string): Promise<Record<string, string>>;
  hdel(key: string, field: string): Promise<void>;
  lpush(key: string, value: string): Promise<void>;
  ltrim(key: string, start: number, stop: number): Promise<void>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
}

export interface ConsensusLogger {
  log(event: {
    eventType: SecurityEventType;
    timestamp: string;
    correlationId: string;
    riskLevel: RiskLevel;
    payload: Record<string, unknown>;
  }): void;
}

// ─── Result type ────────────────────────────────────────────────────────────

export interface ConsensusResult {
  consensus: boolean;
  sources: Array<{ name: string; price: number }>;
  divergencePercent: number;
}

// ─── Class ──────────────────────────────────────────────────────────────────

/**
 * Maintains a rolling store of the latest price per source per instrument.
 * When >= 2 sources exist, computes % divergence between highest and lowest.
 * If divergence exceeds configured threshold, returns consensus: false and
 * emits FEED_CONSENSUS_FAILURE.
 */
export class FeedConsensus {
  private readonly config: SecurityConfig;
  private readonly logger: ConsensusLogger;
  private readonly redis: ConsensusRedisAdapter;

  /** TTL in seconds for each source's price entry */
  private readonly priceTtlSeconds = 30;

  constructor(
    config: SecurityConfig,
    logger: ConsensusLogger,
    redis: ConsensusRedisAdapter,
  ) {
    this.config = config;
    this.logger = logger;
    this.redis = redis;
  }

  /**
   * Record a price observation from `source` for `instrument` and check
   * consensus across all recently-reported sources.
   */
  public async check(
    instrument: string,
    price: number,
    source: string,
  ): Promise<ConsensusResult> {
    // Store price per-source with a short TTL so stale sources expire
    const sourceKey = `feed:consensus:${instrument}:${source}`;
    await this.redis.setex(sourceKey, this.priceTtlSeconds, String(price));

    // Also record source name in the instrument's hash so we can enumerate
    await this.redis.hset(`feed:consensus:sources:${instrument}`, source, '1');

    // Collect live prices from all known sources
    const knownSources = await this.redis.hgetall(
      `feed:consensus:sources:${instrument}`,
    );

    const liveSources: Array<{ name: string; price: number }> = [];
    for (const srcName of Object.keys(knownSources)) {
      const key = `feed:consensus:${instrument}:${srcName}`;
      const raw = await this.redis.get(key);
      if (raw !== null) {
        liveSources.push({ name: srcName, price: Number(raw) });
      } else {
        // Source expired, clean up the hash entry
        await this.redis.hdel(
          `feed:consensus:sources:${instrument}`,
          srcName,
        );
      }
    }

    // With fewer than 2 sources we cannot compute divergence
    if (liveSources.length < 2) {
      return {
        consensus: true,
        sources: liveSources,
        divergencePercent: 0,
      };
    }

    const prices = liveSources.map((s) => s.price);
    const highest = Math.max(...prices);
    const lowest = Math.min(...prices);
    const divergencePercent =
      lowest === 0 ? 100 : ((highest - lowest) / lowest) * 100;

    const threshold = this.config.feedConsensusDivergenceThresholdPercent;

    if (divergencePercent > threshold) {
      const correlationId = randomUUID();
      const feedPrices: Record<string, number> = {};
      for (const s of liveSources) {
        feedPrices[s.name] = s.price;
      }

      this.logger.log({
        eventType: SecurityEventType.FEED_CONSENSUS_FAILURE,
        timestamp: new Date().toISOString(),
        correlationId,
        riskLevel: RiskLevel.HIGH,
        payload: {
          instrument,
          feedPrices,
          divergencePercent,
          threshold,
        },
      });

      return {
        consensus: false,
        sources: liveSources,
        divergencePercent,
      };
    }

    return {
      consensus: true,
      sources: liveSources,
      divergencePercent,
    };
  }
}
