import { Injectable, Optional, Logger } from '@nestjs/common';
import { safeGet } from './security-config';
import { ConfigService } from '@nestjs/config';
import {
  FeedConsensus,
  AnomalyFilter,
  FeedSignatureVerifier,
  MarketDataGuard,
  type ConsensusResult,
  type AnomalyFilterResult,
  type SecurityConfig,
  SecurityEventType,
  RiskLevel,
} from '@super-ai/security';
import { SecurityRedisService } from './security-redis.service';

/**
 * NestJS wrapper around MarketDataGuard from @super-ai/security.
 * Validates market data feeds via consensus checking, anomaly detection,
 * and signature verification.
 */
@Injectable()
export class MarketDataGuardService {
  private readonly logger = new Logger(MarketDataGuardService.name);
  private feedConsensus!: FeedConsensus;
  private anomalyFilter!: AnomalyFilter;
  private marketDataGuard!: MarketDataGuard;

  constructor(
    private readonly config: ConfigService,
    private readonly redis: SecurityRedisService,
  ) {}

  safeInit(): void {
    const securityConfig = this.buildConfig();
    const nestLogger = this.logger;

    // Logger adapter for market-data components (uses structured log method)
    const guardLogger = {
      log: (event: {
        eventType: SecurityEventType;
        timestamp: string;
        correlationId: string;
        riskLevel: RiskLevel;
        payload: Record<string, unknown>;
      }) => {
        nestLogger.log(
          `[${event.eventType}] ${event.correlationId}`,
          event.payload,
        );
      },
    };

    // Market-data Redis adapters expect lpush to return Promise<void>,
    // but ioredis returns Promise<number>. Wrap with a thin adapter.
    const redisAdapter = {
      get: (k: string) => this.redis.get(k),
      set: (k: string, v: string) => this.redis.set(k, v),
      setex: (k: string, ttl: number, v: string) => this.redis.setex(k, ttl, v),
      del: (k: string) => this.redis.del(k),
      hset: (k: string, f: string, v: string) => this.redis.hset(k, f, v),
      hget: (k: string, f: string) => this.redis.hget(k, f),
      hgetall: (k: string) => this.redis.hgetall(k),
      hdel: (k: string, f: string) => this.redis.hdel(k, f),
      lpush: async (k: string, v: string): Promise<void> => { await this.redis.lpush(k, v); },
      ltrim: (k: string, s: number, e: number) => this.redis.ltrim(k, s, e),
      lrange: (k: string, s: number, e: number) => this.redis.lrange(k, s, e),
    };

    this.feedConsensus = new FeedConsensus(
      securityConfig,
      guardLogger,
      redisAdapter,
    );

    this.anomalyFilter = new AnomalyFilter(
      securityConfig,
      guardLogger,
      redisAdapter,
    );

    const signatureVerifier = new FeedSignatureVerifier(
      securityConfig,
      guardLogger,
    );

    this.marketDataGuard = new MarketDataGuard(
      securityConfig,
      guardLogger,
      redisAdapter,
      this.feedConsensus,
      this.anomalyFilter,
      signatureVerifier,
    );

    this.logger.log('MarketDataGuardService initialized');
  }

  /**
   * Validate a price observation against consensus from multiple sources.
   * Records the price and checks divergence across all recently-reported sources.
   */
  async validatePrice(
    instrument: string,
    price: number,
    source: string,
  ): Promise<ConsensusResult> {
    return this.feedConsensus.check(instrument, price, source);
  }

  /**
   * Check if a price is anomalous relative to its recent history.
   * Uses a rolling window with standard deviation-based detection.
   */
  async checkAnomaly(
    instrument: string,
    price: number,
  ): Promise<AnomalyFilterResult> {
    return this.anomalyFilter.check(instrument, price);
  }

  /**
   * Get the underlying MarketDataGuard for full validation (consensus + anomaly + signature).
   */
  getGuard(): MarketDataGuard {
    return this.marketDataGuard;
  }

  private buildConfig(): SecurityConfig {
    return {
      jwtPublicKeyPath: safeGet<string>(this.config, 'JWT_PUBLIC_KEY_PATH', './keys/jwt.pub'),
      jwtPrivateKeyPath: safeGet<string>(this.config, 'JWT_PRIVATE_KEY_PATH', './keys/jwt.key'),
      hmacChainSecret: safeGet<string>(this.config, 'HMAC_CHAIN_SECRET', 'dev-hmac-secret-change-me'),
      signingPrivateKey: safeGet<string>(this.config, 'SIGNING_PRIVATE_KEY', 'dev-signing-private-key'),
      signingPublicKey: safeGet<string>(this.config, 'SIGNING_PUBLIC_KEY', 'dev-signing-public-key'),
      adminUserId: safeGet<string>(this.config, 'ADMIN_USER_ID', 'admin'),
      marketDataStalenessThresholdMs: safeGet<number>(this.config, 'MARKET_DATA_STALENESS_MS', 30_000),
      feedConsensusDivergenceThresholdPercent: safeGet<number>(this.config, 'FEED_CONSENSUS_DIVERGENCE_PERCENT', 2),
      feedSignaturePublicKeys: this.parseJsonEnv<Record<string, string>>('FEED_SIGNATURE_PUBLIC_KEYS', {}),
      anomalyStdDevMultiplier: safeGet<number>(this.config, 'ANOMALY_STD_DEV_MULTIPLIER', 3),
      anomalyWindowSize: safeGet<number>(this.config, 'ANOMALY_WINDOW_SIZE', 100),
      environment: safeGet<'development' | 'staging' | 'production'>(this.config, 'NODE_ENV', 'development') as 'development' | 'staging' | 'production',
    } as SecurityConfig;
  }

  private parseJsonEnv<T>(key: string, fallback: T): T {
    const raw = safeGet<string>(this.config, key);
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      this.logger.warn(`Failed to parse env ${key} as JSON, using default`);
      return fallback;
    }
  }
}
