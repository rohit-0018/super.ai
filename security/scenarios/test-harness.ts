/**
 * Agent Scenario Test Harness
 *
 * Wires all security components together with in-memory mocks (no Redis, no real KMS)
 * to simulate the full pipeline an autonomous trading agent request passes through.
 *
 * This is NOT a unit test helper — it constructs real component instances with real
 * logic, only substituting I/O boundaries (Redis, file system, network).
 */

import { SecurityEventType, RiskLevel, SourceTrust } from '../types/events.js';
import { AgentActionType, OrderSide, OrderType } from '../types/actions.js';
import type { AgentAction, PlaceOrderAction } from '../types/actions.js';
import type { PortfolioSnapshot, PositionSnapshot } from '../types/risk.js';
import type { SecurityConfig } from '../types/config.js';

// ── Component imports ──
import { PiiScrubber } from '../input/pii.scrubber.js';
import { InjectionDetector } from '../input/injection.detector.js';
import { ContextIntegrityService } from '../input/context.integrity.js';
import { SourceTrustClassifier } from '../input/source.trust.classifier.js';
import { InputGuard, type RawInput } from '../input/input.guard.js';
import { ActionAllowlist } from '../output/action.allowlist.js';
import { SanityChecker, type MarketDataService } from '../output/sanity.checker.js';
import { DuplicateDetector } from '../output/duplicate.detector.js';
import { OutputFilter } from '../output/output.filter.js';
import { WashTradeDetector } from '../compliance/wash.trade.detector.js';
import { ShortSellControl, AccountType } from '../compliance/short.sell.control.js';
import { PositionLimitsChecker } from '../risk/position.limits.js';
import { FeedConsensus } from '../market-data/feed.consensus.js';
import { AnomalyFilter } from '../market-data/anomaly.filter.js';

// ─── In-memory Redis mock ──────────────────────────────────────────────────

export class InMemoryRedis {
  private store: Map<string, { value: string; expiresAt: number | null }> = new Map();
  private hashes: Map<string, Map<string, string>> = new Map();
  private lists: Map<string, string[]> = new Map();

  private isExpired(key: string): boolean {
    const entry = this.store.get(key);
    if (entry?.expiresAt !== null && entry?.expiresAt !== undefined && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return true;
    }
    return false;
  }

  async get(key: string): Promise<string | null> {
    this.isExpired(key);
    return this.store.get(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const expiresAt = ttlSeconds !== undefined ? Date.now() + ttlSeconds * 1000 : null;
    this.store.set(key, { value, expiresAt });
  }

  async setex(key: string, ttlSeconds: number, value: string): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
    this.hashes.delete(key);
    this.lists.delete(key);
  }

  async incr(key: string): Promise<number> {
    const val = this.store.get(key)?.value ?? '0';
    const newVal = parseInt(val, 10) + 1;
    const existing = this.store.get(key);
    this.store.set(key, { value: String(newVal), expiresAt: existing?.expiresAt ?? null });
    return newVal;
  }

  async expire(key: string, seconds: number): Promise<void> {
    const entry = this.store.get(key);
    if (entry) {
      entry.expiresAt = Date.now() + seconds * 1000;
    }
  }

  async lpush(key: string, value: string): Promise<number> {
    const list = this.lists.get(key) ?? [];
    list.unshift(value);
    this.lists.set(key, list);
    return list.length;
  }

  async ltrim(key: string, start: number, stop: number): Promise<void> {
    const list = this.lists.get(key) ?? [];
    this.lists.set(key, list.slice(start, stop + 1));
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.lists.get(key) ?? [];
    return list.slice(start, stop < 0 ? undefined : stop + 1);
  }

  async hset(key: string, field: string, value: string): Promise<void> {
    const hash = this.hashes.get(key) ?? new Map();
    hash.set(field, value);
    this.hashes.set(key, hash);
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.hashes.get(key)?.get(field) ?? null;
  }

  async hdel(key: string, field: string): Promise<void> {
    this.hashes.get(key)?.delete(field);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const hash = this.hashes.get(key);
    if (!hash) return {};
    const result: Record<string, string> = {};
    for (const [k, v] of hash) {
      result[k] = v;
    }
    return result;
  }

  /** Clear all data (call between scenarios) */
  clear(): void {
    this.store.clear();
    this.hashes.clear();
    this.lists.clear();
  }
}

// ─── Event collector ───────────────────────────────────────────────────────

export interface CollectedEvent {
  eventType: string;
  payload: Record<string, unknown>;
}

export class EventCollector {
  public readonly events: CollectedEvent[] = [];

  emit(event: string | SecurityEventType, payload: Record<string, unknown> = {}): void {
    this.events.push({ eventType: event, payload });
  }

  /** Also serves as the AlertBus-shaped emit */
  emitAlert(alert: {
    level: string;
    type: string;
    message: string;
    correlationId: string;
    metadata: Record<string, unknown>;
  }): void {
    this.events.push({
      eventType: alert.type,
      payload: { level: alert.level, message: alert.message, ...alert.metadata },
    });
  }

  hasEvent(type: SecurityEventType): boolean {
    return this.events.some((e) => e.eventType === type);
  }

  getEvents(type: SecurityEventType): CollectedEvent[] {
    return this.events.filter((e) => e.eventType === type);
  }

  clear(): void {
    this.events.length = 0;
  }
}

// ─── Noop/minimal logger ───────────────────────────────────────────────────

export class SilentLogger {
  info(_msg: string, _meta?: Record<string, unknown>): void { /* noop */ }
  warn(_msg: string, _meta?: Record<string, unknown>): void { /* noop */ }
  error(_msg: string, _meta?: Record<string, unknown>): void { /* noop */ }
  log(_event: Record<string, unknown>): void { /* noop */ }
}

// ─── AgentTestHarness ──────────────────────────────────────────────────────

export interface HarnessConfig {
  approvedUniverse: string[];
  positionLimits: Record<string, number>;
  portfolioNotionalLimit: number;
  sessionDrawdownKillSwitchPercent: number;
  injectionThreshold: number;
  feedDivergencePercent: number;
  highValueConfirmationThreshold: number;
  washTradeWindowMs: number;
}

const DEFAULT_HARNESS_CONFIG: HarnessConfig = {
  approvedUniverse: ['BTC-USD', 'ETH-USD', 'SOL-USD'],
  positionLimits: { 'BTC-USD': 10, 'ETH-USD': 100, 'SOL-USD': 1000 },
  portfolioNotionalLimit: 1_000_000,
  sessionDrawdownKillSwitchPercent: 10,
  injectionThreshold: 0.6,
  feedDivergencePercent: 2.0,
  highValueConfirmationThreshold: 100_000,
  washTradeWindowMs: 300_000,
};

export class AgentTestHarness {
  public readonly redis: InMemoryRedis;
  public readonly events: EventCollector;
  public readonly logger: SilentLogger;
  public readonly config: HarnessConfig;

  // Components
  public readonly inputGuard: InputGuard;
  public readonly outputFilter: OutputFilter;
  public readonly washTradeDetector: WashTradeDetector;
  public readonly shortSellControl: ShortSellControl;
  public readonly positionLimitsChecker: PositionLimitsChecker;
  public readonly feedConsensus: FeedConsensus;
  public readonly anomalyFilter: AnomalyFilter;

  private currentPrices: Record<string, number> = {
    'BTC-USD': 50000,
    'ETH-USD': 3001,
    'SOL-USD': 100,
  };

  constructor(overrides: Partial<HarnessConfig> = {}) {
    this.config = { ...DEFAULT_HARNESS_CONFIG, ...overrides };
    this.redis = new InMemoryRedis();
    this.events = new EventCollector();
    this.logger = new SilentLogger();

    const securityConfig = this.buildSecurityConfig();

    // ── Input Guard ──
    const piiScrubber = new PiiScrubber();
    const injectionDetector = new InjectionDetector({
      injectionDetectionThresholdScore: this.config.injectionThreshold,
    });
    const contextIntegrity = new ContextIntegrityService(
      { hmacChainSecret: 'test-secret' },
      this.logger,
      this.redis,
      this.events,
    );
    const sourceClassifier = new SourceTrustClassifier({
      sourceTrustMap: {
        'system': SourceTrust.INTERNAL,
        'exchange-feed': SourceTrust.VERIFIED_EXTERNAL,
        'news-api': SourceTrust.UNVERIFIED_EXTERNAL,
        'user': SourceTrust.UNVERIFIED_EXTERNAL,
      },
    });

    this.inputGuard = new InputGuard({
      piiScrubber,
      injectionDetector,
      contextIntegrity,
      sourceClassifier,
      logger: this.logger,
      emitter: this.events,
      systemPrompt: 'You are a trading agent.',
    });

    // ── Output Filter ──
    const allowlist = new ActionAllowlist({ logger: this.logger, emitter: this.events });
    const marketDataService: MarketDataService = {
      getCurrentPrice: async (instrument: string) => {
        return this.currentPrices[instrument] ?? 0;
      },
    };
    const sanityChecker = new SanityChecker({
      config: {
        approvedTradingUniverse: this.config.approvedUniverse,
        positionLimitsPerInstrument: this.config.positionLimits,
        portfolioNotionalLimit: this.config.portfolioNotionalLimit,
        feedConsensusDivergenceThresholdPercent: this.config.feedDivergencePercent,
      },
      logger: this.logger,
      marketDataService,
      emitter: this.events,
    });
    const duplicateDetector = new DuplicateDetector({
      logger: this.logger,
      redisAdapter: this.redis,
      emitter: this.events,
    });

    this.outputFilter = new OutputFilter({
      allowlist,
      sanityChecker,
      duplicateDetector,
      logger: this.logger,
      emitter: this.events,
    });

    // ── Compliance ──
    const alertBusAdapter = {
      emit: (alert: { level: string; type: string; message: string; correlationId: string; metadata: Record<string, unknown> }) => {
        this.events.emitAlert(alert);
      },
    };

    this.washTradeDetector = new WashTradeDetector(
      securityConfig,
      this.logger,
      this.redis,
      alertBusAdapter,
    );

    this.shortSellControl = new ShortSellControl(this.logger, alertBusAdapter);

    // ── Risk ──
    this.positionLimitsChecker = new PositionLimitsChecker(
      securityConfig,
      this.logger,
      alertBusAdapter,
    );

    // ── Market Data ──
    const loggerAdapter = {
      log: (event: Record<string, unknown>) => {
        this.events.emit(event['eventType'] as string ?? 'unknown', event);
      },
    };

    this.feedConsensus = new FeedConsensus(
      securityConfig,
      loggerAdapter,
      this.redis,
    );

    this.anomalyFilter = new AnomalyFilter(
      securityConfig,
      loggerAdapter,
      this.redis,
    );
  }

  // ─── Public helpers ──────────────────────────────────────────────────────

  /** Seal the system prompt for a session (must be called before processing input) */
  async sealSession(sessionId: string): Promise<void> {
    const contextIntegrity = new ContextIntegrityService(
      { hmacChainSecret: 'test-secret' },
      this.logger,
      this.redis,
    );
    await contextIntegrity.seal('You are a trading agent.', sessionId);
  }

  /** Set current market prices for the sanity checker */
  setPrice(instrument: string, price: number): void {
    this.currentPrices[instrument] = price;
  }

  /** Build a standard PlaceOrderAction */
  buildOrder(overrides: Partial<PlaceOrderAction> = {}): PlaceOrderAction {
    return {
      type: AgentActionType.PlaceOrder,
      instrument: 'BTC-USD',
      side: OrderSide.BUY,
      orderType: OrderType.LIMIT,
      quantity: 1,
      price: 50000,
      strategyId: 'strat-001',
      clientOrderId: crypto.randomUUID(),
      ...overrides,
    };
  }

  /** Build a standard portfolio snapshot */
  buildPortfolio(positions: PositionSnapshot[] = []): PortfolioSnapshot {
    const totalNotional = positions.reduce((sum, p) => sum + p.notionalValue, 0);
    const totalUnrealizedPnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
    return {
      positions,
      totalNotional,
      totalUnrealizedPnl,
      drawdownFromHighWatermarkPercent: 0,
    };
  }

  /** Build a position snapshot */
  buildPosition(instrument: string, quantity: number, avgPrice: number, currentPrice: number): PositionSnapshot {
    return {
      instrument,
      quantity,
      averageEntryPrice: avgPrice,
      currentPrice,
      unrealizedPnl: (currentPrice - avgPrice) * quantity,
      notionalValue: currentPrice * quantity,
    };
  }

  /** Reset state between scenarios */
  reset(): void {
    this.redis.clear();
    this.events.clear();
    this.currentPrices = { 'BTC-USD': 50000, 'ETH-USD': 3001, 'SOL-USD': 100 };
  }

  private buildSecurityConfig(): SecurityConfig {
    // Minimal config that satisfies the components we're wiring
    return {
      jwtPublicKeyPath: '',
      jwtPrivateKeyPath: '',
      jwtAccessTokenExpirySeconds: 900,
      jwtRefreshTokenExpirySeconds: 86400,
      mfaTotpIssuer: 'test',
      mfaStepUpRiskLevel: RiskLevel.HIGH,
      deviceTrustScoreThreshold: 50,
      deviceTrustIncrement: 10,
      marketDataStalenessMs: 5000,
      feedConsensusDivergenceThresholdPercent: this.config.feedDivergencePercent,
      anomalyStdDevMultiplier: 3.0,
      anomalyWindowSize: 100,
      injectionDetectionThresholdScore: this.config.injectionThreshold,
      piiScrubbingPatterns: [],
      approvedTradingUniverse: this.config.approvedUniverse,
      positionLimitsPerInstrument: this.config.positionLimits,
      portfolioNotionalLimit: this.config.portfolioNotionalLimit,
      sessionDrawdownKillSwitchPercent: this.config.sessionDrawdownKillSwitchPercent,
      velocityCbOrderCount: 50,
      velocityCbWindowSeconds: 60,
      errorRateCbConsecutiveRejections: 10,
      tradingHoursPerMarket: { DEFAULT: { open: '00:00', close: '23:59' } },
      highValueConfirmationThreshold: this.config.highValueConfirmationThreshold,
      washTradeDetectionWindowMs: this.config.washTradeWindowMs,
      layeringDetectionWindowMs: 60000,
      layeringCancelRatioThreshold: 0.8,
      rateLimitUser: { requests: 100, windowMs: 60000 },
      rateLimitStrategy: { requests: 50, windowMs: 60000 },
      rateLimitInstrument: { requests: 200, windowMs: 60000 },
      rateLimitExchange: { requests: 30, windowMs: 1000 },
      redisUrl: 'redis://localhost:6379',
      kmsKeyArn: '',
      kmsProvider: 'local' as const,
      secretsRotationPollIntervalSeconds: 300,
      deadManSwitchHeartbeatTimeoutSeconds: 60,
      auditLogOutputPath: '/tmp/test-audit.jsonl',
      hmacChainSecret: 'test-secret',
      corsAllowedOrigins: ['http://localhost:3001'],
      alertWebhookUrls: [],
      alertSlackChannel: '',
      alertSlackWebhookUrl: '',
      feedSignaturePublicKeys: {},
      encryptionKeyId: 'test-key',
      signingPrivateKey: '',
      signingPublicKey: '',
      adminUserId: 'admin',
      environment: 'development' as const,
    } as SecurityConfig; // SecurityConfig Zod type — casting at test boundary
  }
}

export { AgentActionType, OrderSide, OrderType, AccountType, SecurityEventType, RiskLevel };
export type { AgentAction, PlaceOrderAction, PortfolioSnapshot, RawInput };
