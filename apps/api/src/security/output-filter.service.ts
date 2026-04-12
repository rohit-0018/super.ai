import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { safeGet } from './security-config';
import { ConfigService } from '@nestjs/config';
import {
  OutputFilter,
  ActionAllowlist,
  SanityChecker,
  DuplicateDetector,
  type FilteredOutput,
  type PortfolioSnapshot,
} from '@super-ai/security';
import { SecurityRedisService } from './security-redis.service';

/**
 * Interface matching what SanityChecker expects for market data lookups.
 * Consumers should provide a class that implements this and bind it to
 * the MARKET_DATA_PORT token.
 */
export interface MarketDataPort {
  getCurrentPrice(instrument: string): Promise<number>;
}

export const MARKET_DATA_PORT = 'SECURITY_MARKET_DATA_PORT';

/**
 * NestJS wrapper around OutputFilter from @super-ai/security.
 * Validates LLM output actions: allow-list check, sanity check (position limits,
 * trading universe, notional limits), and duplicate detection.
 */
@Injectable()
export class OutputFilterService {
  private readonly logger = new Logger(OutputFilterService.name);
  private outputFilter!: OutputFilter;

  constructor(
    private readonly config: ConfigService,
    private readonly redis: SecurityRedisService,
    @Optional() @Inject(MARKET_DATA_PORT) private readonly marketData?: MarketDataPort,
  ) {}

  safeInit(): void {
    const nestLogger = this.logger;
    const loggerAdapter = {
      info: (msg: string, meta?: Record<string, unknown>) =>
        nestLogger.log(msg, meta),
      warn: (msg: string, meta?: Record<string, unknown>) =>
        nestLogger.warn(msg, meta),
      error: (msg: string, meta?: Record<string, unknown>) =>
        nestLogger.error(msg, meta),
    };

    const allowlist = new ActionAllowlist({ logger: loggerAdapter });

    const marketDataService = this.marketData ?? {
      getCurrentPrice: async (_instrument: string) => 0,
    };

    const sanityChecker = new SanityChecker({
      config: {
        approvedTradingUniverse: this.parseJsonEnv<string[]>(
          'APPROVED_TRADING_UNIVERSE',
          [],
        ),
        positionLimitsPerInstrument: this.parseJsonEnv<Record<string, number>>(
          'POSITION_LIMITS_PER_INSTRUMENT',
          {},
        ),
        portfolioNotionalLimit: this.config?.get<number>(
          'PORTFOLIO_NOTIONAL_LIMIT',
          1_000_000,
        ),
        feedConsensusDivergenceThresholdPercent: this.config?.get<number>(
          'FEED_CONSENSUS_DIVERGENCE_PERCENT',
          2,
        ),
      },
      logger: loggerAdapter,
      marketDataService,
    });

    const duplicateDetector = new DuplicateDetector({
      config: {
        dedupWindowSeconds: safeGet<number>(this.config, 'DEDUP_WINDOW_SECONDS', 60),
        redisKeyPrefix: 'sec:dedup:',
      },
      logger: loggerAdapter,
      redisAdapter: this.redis,
    });

    this.outputFilter = new OutputFilter({
      allowlist,
      sanityChecker,
      duplicateDetector,
      logger: loggerAdapter,
    });

    this.logger.log('OutputFilterService initialized');
  }

  /**
   * Run the full output filtering pipeline on raw LLM output.
   */
  async process(
    rawLlmOutput: unknown,
    portfolio: PortfolioSnapshot,
  ): Promise<FilteredOutput> {
    return this.outputFilter.process(rawLlmOutput, portfolio);
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
