// ─── Security Module Bootstrap ──────────────────────────────────────────────
//
// Wires every security sub-module into a single middleware stack and returns
// all services for application-level use.
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { KMSClient } from '@aws-sdk/client-kms';
import type { Request, Response, NextFunction } from 'express';

import { SecurityConfigSchema, type SecurityConfig } from './types/config.js';
import { SecurityError, SecurityErrorCode } from './types/errors.js';
import { RiskLevel, SecurityEventType } from './types/events.js';
import type { LogEntry } from './audit/log.entry.schema.js';
import { LogEntrySchema } from './audit/log.entry.schema.js';

// ── Concrete classes ────────────────────────────────────────────────────────

import { RedisAdapter } from './rate-limit/redis.adapter.js';
import { LocalKmsAdapter, AwsKmsAdapter, type KmsAdapter } from './secrets/kms.adapter.js';
import { SecretsLoader } from './secrets/secrets.loader.js';
import { HmacChain } from './audit/hmac.chain.js';
import { AuditLogger, JsonlFileWriter } from './audit/audit.logger.js';
import { ForensicsService } from './audit/forensics.service.js';
import {
  AlertBus,
  WebhookAlertConsumer,
  SlackAlertConsumer,
  LogAlertConsumer,
  type HttpClient,
} from './anomaly/alert.bus.js';
import { KillSwitch } from './risk/kill.switch.js';
import { CircuitBreaker } from './risk/circuit.breaker.js';
import { PositionLimitsChecker } from './risk/position.limits.js';
import { LossMonitor } from './risk/loss.monitor.js';
import { RiskEngine } from './risk/risk.engine.js';
import { DeadMansSwitch } from './secrets/dead.mans.switch.js';
import { KeyRotationWatcher } from './secrets/key.rotation.watcher.js';
import { CryptoService } from './crypto/crypto.service.js';
import { SigningService } from './crypto/signing.service.js';
import { createCorsMiddleware } from './headers/cors.middleware.js';
import { createSecurityHeaders } from './headers/security.headers.js';
import { JwtValidator } from './auth/jwt.validator.js';
import { SessionBinder } from './auth/session.binder.js';
import { MfaGate } from './auth/mfa.gate.js';
import { DeviceTrustService } from './auth/device.trust.js';
import { TokenRotator } from './auth/token.rotator.js';
import { PiiScrubber } from './input/pii.scrubber.js';
import { InjectionDetector } from './input/injection.detector.js';
import { ContextIntegrityService } from './input/context.integrity.js';
import { SourceTrustClassifier } from './input/source.trust.classifier.js';
import { InputGuard } from './input/input.guard.js';
import { ActionAllowlist } from './output/action.allowlist.js';
import { SanityChecker, type MarketDataService } from './output/sanity.checker.js';
import { DuplicateDetector } from './output/duplicate.detector.js';
import { OutputFilter } from './output/output.filter.js';
import { ConfirmationGate } from './confirmation/confirmation.gate.js';
import { ApprovalFlow } from './confirmation/approval.flow.js';
import { WashTradeDetector } from './compliance/wash.trade.detector.js';
import { LayeringDetector } from './compliance/layering.detector.js';
import { ShortSellControl } from './compliance/short.sell.control.js';
import { TradeReporter, LocalJsonlTradeReporter } from './compliance/trade.reporter.js';
import { MarketDataGuard } from './market-data/market.data.guard.js';
import { FeedConsensus } from './market-data/feed.consensus.js';
import { AnomalyFilter } from './market-data/anomaly.filter.js';
import { FeedSignatureVerifier } from './market-data/feed.signature.verifier.js';
import { AnomalyDetector, type GeoIpAdapter } from './anomaly/anomaly.detector.js';
import { StrategyDriftDetector } from './anomaly/strategy.drift.detector.js';
import { RateLimiter } from './rate-limit/rate.limiter.js';

// ─── Express middleware type alias ──────────────────────────────────────────

type RequestHandler = (req: Request, res: Response, next: NextFunction) => void;

// ─── SecurityMiddlewareStack ────────────────────────────────────────────────

export interface SecurityMiddlewareStack {
  readonly middleware: readonly RequestHandler[];
  readonly killSwitch: KillSwitch;
  readonly alertBus: AlertBus;
  readonly riskEngine: RiskEngine;
  readonly auditLogger: AuditLogger;
  readonly forensicsService: ForensicsService;
  readonly inputGuard: InputGuard;
  readonly outputFilter: OutputFilter;
  readonly confirmationGate: ConfirmationGate;
  readonly marketDataGuard: MarketDataGuard;
  readonly anomalyDetector: AnomalyDetector;
  readonly cryptoService: CryptoService;
  readonly signingService: SigningService;
  readonly rateLimiter: RateLimiter;
  readonly jwtValidator: JwtValidator;
  readonly sessionBinder: SessionBinder;
  readonly mfaGate: MfaGate;
  readonly deviceTrustService: DeviceTrustService;
  readonly tokenRotator: TokenRotator;
  readonly complianceServices: {
    readonly washTradeDetector: WashTradeDetector;
    readonly layeringDetector: LayeringDetector;
    readonly shortSellControl: ShortSellControl;
    readonly tradeReporter: TradeReporter;
  };
}

// ─── Minimal logger that writes to stderr / stdout ──────────────────────────

interface InternalLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

function createConsoleLogger(): InternalLogger {
  return {
    info(message: string, meta?: Record<string, unknown>): void {
      process.stdout.write(`[security:info] ${message} ${meta ? JSON.stringify(meta) : ''}\n`);
    },
    warn(message: string, meta?: Record<string, unknown>): void {
      process.stderr.write(`[security:warn] ${message} ${meta ? JSON.stringify(meta) : ''}\n`);
    },
    error(message: string, meta?: Record<string, unknown>): void {
      process.stderr.write(`[security:error] ${message} ${meta ? JSON.stringify(meta) : ''}\n`);
    },
  };
}

// ─── Minimal fetch-based HttpClient for alert consumers ─────────────────────

function createFetchHttpClient(): HttpClient {
  return {
    async post(
      url: string,
      body: string,
      headers: Record<string, string>,
    ): Promise<{ status: number }> {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
      });
      return { status: response.status };
    },
  };
}

// ─── Minimal GeoIP adapter (noop for bootstrap; replace at app level) ──────

function createNoopGeoIpAdapter(): GeoIpAdapter {
  return {
    async lookup(_ip: string) {
      return null;
    },
  };
}

// ─── Stub MarketDataService for sanity checker ──────────────────────────────

function createStubMarketDataService(): MarketDataService {
  return {
    async getCurrentPrice(_instrument: string): Promise<number> {
      return 0;
    },
  };
}

// ─── FileSystem adapter for trade reporter ──────────────────────────────────

function createNodeFsAdapter(): { appendFile(path: string, data: string): Promise<void> } {
  return {
    async appendFile(path: string, data: string): Promise<void> {
      const { appendFile } = await import('node:fs/promises');
      await appendFile(path, data, 'utf-8');
    },
  };
}

// ─── Bootstrap ──────────────────────────────────────────────────────────────

export async function bootstrapSecurity(
  config: SecurityConfig,
): Promise<SecurityMiddlewareStack> {
  // 1. Validate config with Zod schema
  const parseResult = SecurityConfigSchema.safeParse(config);
  if (!parseResult.success) {
    throw new SecurityError(
      `Invalid SecurityConfig: ${parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      SecurityErrorCode.AUDIT_WRITE_FAILED,
      RiskLevel.CRITICAL,
      randomUUID(),
      { zodErrors: parseResult.error.issues },
    );
  }
  const validatedConfig = parseResult.data;

  const logger = createConsoleLogger();
  const httpClient = createFetchHttpClient();

  // 2. Create RedisAdapter, connect, verify health
  const redisAdapter = new RedisAdapter(validatedConfig.redisUrl);
  const redisHealthy = await redisAdapter.healthCheck();
  if (!redisHealthy) {
    throw new SecurityError(
      'Redis health check failed during security bootstrap',
      SecurityErrorCode.SECRET_KMS_UNAVAILABLE,
      RiskLevel.CRITICAL,
      randomUUID(),
      { redisUrl: validatedConfig.redisUrl },
    );
  }
  logger.info('Redis connected and healthy');

  // 3. Create KmsAdapter based on config.kmsProvider
  let kmsAdapter: KmsAdapter;
  if (validatedConfig.kmsProvider === 'aws') {
    const kmsClient = new KMSClient({});
    kmsAdapter = new AwsKmsAdapter(kmsClient, validatedConfig.kmsKeyArn);
  } else {
    kmsAdapter = new LocalKmsAdapter();
  }
  logger.info('KMS adapter created', { provider: validatedConfig.kmsProvider });

  // 4. Create SecretsLoader and load secrets
  const secretsLoader = new SecretsLoader(
    kmsAdapter,
    {
      requiredSecrets: [],
      kmsProvider: validatedConfig.kmsProvider,
    },
    logger,
    {
      emit(alert) {
        logger.info(alert.message, alert.metadata);
      },
    },
  );
  // Load may be empty if no required secrets are configured
  await secretsLoader.load();
  logger.info('Secrets loaded');

  // 5. Create HmacChain, JsonlFileWriter, AuditLogger
  const hmacChain = new HmacChain(validatedConfig.hmacChainSecret);
  const jsonlFileWriter = new JsonlFileWriter(validatedConfig.auditLogOutputPath);
  const auditLogger = new AuditLogger(validatedConfig, hmacChain, jsonlFileWriter);
  logger.info('Audit logger initialized', { outputPath: validatedConfig.auditLogOutputPath });

  // 6. Create AlertBus with configured consumers
  const alertBus = new AlertBus(logger);

  // Register WebhookAlertConsumer for each webhook URL
  for (const webhookUrl of validatedConfig.alertWebhookUrls) {
    const consumer = new WebhookAlertConsumer(
      webhookUrl,
      validatedConfig.hmacChainSecret,
      httpClient,
    );
    alertBus.register(consumer);
    logger.info('Registered webhook alert consumer', { webhookUrl });
  }

  // Register SlackAlertConsumer if Slack is configured
  if (validatedConfig.alertSlackWebhookUrl) {
    const slackConsumer = new SlackAlertConsumer(
      validatedConfig.alertSlackWebhookUrl,
      httpClient,
    );
    alertBus.register(slackConsumer);
    logger.info('Registered Slack alert consumer', {
      channel: validatedConfig.alertSlackChannel,
    });
  }

  // Register LogAlertConsumer (always)
  const logAlertConsumer = new LogAlertConsumer({
    log(message: string, data: Record<string, unknown>): void {
      logger.info(message, data);
    },
  });
  alertBus.register(logAlertConsumer);
  logger.info('Registered log alert consumer');

  // 7. Run HMAC chain integrity check on startup
  try {
    const { readFile: readFileFs } = await import('node:fs/promises');
    const rawLog = await readFileFs(validatedConfig.auditLogOutputPath, 'utf-8');
    const lines = rawLog.split('\n').filter((line) => line.trim().length > 0);
    const entries: LogEntry[] = [];

    for (const line of lines) {
      try {
        const parsed: unknown = JSON.parse(line);
        const result = LogEntrySchema.safeParse(parsed);
        if (result.success) {
          entries.push(result.data);
        }
      } catch {
        // Skip malformed lines
      }
    }

    if (entries.length > 0) {
      const chainResult = hmacChain.verifyChain(entries);
      if (!chainResult.valid) {
        logger.error('HMAC chain integrity check FAILED on startup', {
          firstInvalidIndex: chainResult.firstInvalidIndex,
          totalEntries: chainResult.totalEntries,
        });
        await alertBus.emit({
          eventType: SecurityEventType.AUDIT_CHAIN_INVALID,
          riskLevel: RiskLevel.CRITICAL,
          description: `Audit log HMAC chain broken at index ${chainResult.firstInvalidIndex}`,
          payload: {
            brokenAtIndex: chainResult.firstInvalidIndex,
            totalEntries: chainResult.totalEntries,
          },
          timestamp: new Date().toISOString(),
        });
      } else {
        logger.info('HMAC chain integrity verified', {
          totalEntries: chainResult.totalEntries,
        });
      }
    } else {
      logger.info('No existing audit log entries to verify');
    }
  } catch (err: unknown) {
    // File may not exist yet on first run; that is fine
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('ENOENT')) {
      logger.info('No existing audit log file found, starting fresh');
    } else {
      logger.warn('Could not read audit log for chain verification', { error: message });
    }
  }

  // 8. Create all services in correct dependency order

  // ── Forensics ──
  const forensicsService = new ForensicsService(validatedConfig, hmacChain);

  // ── Kill Switch ──
  const killSwitch = new KillSwitch(
    validatedConfig,
    logger,
    alertBus as never,
    redisAdapter as never,
  );

  // ── Circuit Breakers ──
  const velocityBreaker = new CircuitBreaker(
    'velocity',
    validatedConfig.velocityCircuitBreakerOrderCount,
    validatedConfig.velocityCircuitBreakerWindowSeconds * 1000,
    30_000, // 30s reset timeout
    logger,
    alertBus as never,
    redisAdapter as never,
  );

  const errorRateBreaker = new CircuitBreaker(
    'error-rate',
    validatedConfig.errorRateCircuitBreakerConsecutiveRejectionCount,
    60_000, // 60s window
    30_000, // 30s reset timeout
    logger,
    alertBus as never,
    redisAdapter as never,
  );

  const lossBreaker = new CircuitBreaker(
    'loss',
    1, // single loss limit breach opens
    60_000,
    60_000, // 60s reset timeout
    logger,
    alertBus as never,
    redisAdapter as never,
  );

  // ── Position Limits ──
  const positionLimitsChecker = new PositionLimitsChecker(
    validatedConfig,
    logger,
    alertBus as never,
  );

  // ── Loss Monitor ──
  const lossMonitor = new LossMonitor(
    validatedConfig,
    logger,
    alertBus as never,
    killSwitch,
    redisAdapter as never,
  );

  // ── Risk Engine ──
  const riskEngine = new RiskEngine(
    validatedConfig,
    logger,
    alertBus as never,
    killSwitch,
    positionLimitsChecker,
    lossMonitor,
    velocityBreaker,
    errorRateBreaker,
    lossBreaker,
  );

  // ── Dead Man's Switch ──
  const deadMansSwitch = new DeadMansSwitch(
    { deadManSwitchHeartbeatTimeoutSeconds: validatedConfig.deadManSwitchHeartbeatTimeoutSeconds },
    logger,
    killSwitch,
    redisAdapter as never,
    alertBus as never,
  );
  deadMansSwitch.start();
  logger.info('Dead man switch started', {
    timeoutSeconds: validatedConfig.deadManSwitchHeartbeatTimeoutSeconds,
  });

  // ── Key Rotation Watcher ──
  const keyRotationWatcher = new KeyRotationWatcher(
    secretsLoader,
    kmsAdapter,
    {
      secretsRotationPollIntervalSeconds: validatedConfig.secretsRotationPollIntervalSeconds,
      requiredSecrets: [],
    },
    logger,
    alertBus as never,
  );
  keyRotationWatcher.start();
  logger.info('Key rotation watcher started');

  // ── Crypto & Signing ──
  const cryptoService = new CryptoService(secretsLoader);
  const signingService = new SigningService(secretsLoader);

  // ── Auth services ──
  // The JwtValidator expects a logger matching its local AuditLogger interface
  const jwtAuditLoggerAdapter = {
    log(event: {
      eventType: SecurityEventType;
      timestamp: string;
      correlationId: string;
      riskLevel: RiskLevel;
      payload: Record<string, unknown>;
    }): void {
      logger.info(`[jwt] ${event.eventType}`, {
        correlationId: event.correlationId,
        riskLevel: event.riskLevel,
        ...event.payload,
      });
    },
  };

  const jwtValidator = new JwtValidator(validatedConfig, jwtAuditLoggerAdapter);

  const sessionBinder = new SessionBinder(
    validatedConfig,
    jwtAuditLoggerAdapter,
    alertBus as never,
    redisAdapter as never,
  );

  const mfaGate = new MfaGate(
    validatedConfig,
    jwtAuditLoggerAdapter,
    redisAdapter as never,
    {
      async getTotpSecret(userId: string): Promise<string> {
        return secretsLoader.get(`totp:${userId}`);
      },
    },
  );

  const deviceTrustService = new DeviceTrustService(
    validatedConfig,
    redisAdapter as never,
  );

  const tokenRotator = new TokenRotator(
    validatedConfig,
    redisAdapter as never,
    jwtValidator,
    jwtAuditLoggerAdapter,
  );

  // ── Input Guard ──
  const piiScrubber = new PiiScrubber();
  const injectionDetector = new InjectionDetector(validatedConfig);
  const contextIntegrity = new ContextIntegrityService(
    validatedConfig,
    logger,
    redisAdapter as never,
  );
  const sourceClassifier = new SourceTrustClassifier({
    sourceTrustMap: {},
  });

  const inputGuard = new InputGuard({
    piiScrubber,
    injectionDetector,
    contextIntegrity,
    sourceClassifier,
    logger,
    systemPrompt: '',
  });

  // ── Output Filter ──
  const actionAllowlist = new ActionAllowlist({ logger });
  const sanityChecker = new SanityChecker({
    config: {
      approvedTradingUniverse: validatedConfig.approvedTradingUniverse,
      positionLimitsPerInstrument: validatedConfig.positionLimitsPerInstrument,
      portfolioNotionalLimit: validatedConfig.portfolioNotionalLimit,
      feedConsensusDivergenceThresholdPercent: validatedConfig.feedConsensusDivergenceThresholdPercent,
    },
    logger,
    marketDataService: createStubMarketDataService(),
  });
  const duplicateDetector = new DuplicateDetector({
    logger,
    redisAdapter: redisAdapter as never,
  });

  const outputFilter = new OutputFilter({
    allowlist: actionAllowlist,
    sanityChecker,
    duplicateDetector,
    logger,
  });

  // ── Confirmation Gate ──
  const approvalFlow = new ApprovalFlow(
    validatedConfig,
    logger,
    redisAdapter as never,
  );
  const confirmationGate = new ConfirmationGate(validatedConfig, approvalFlow);

  // ── Compliance Services ──
  const washTradeDetector = new WashTradeDetector(
    validatedConfig,
    logger,
    redisAdapter as never,
    alertBus as never,
  );

  const layeringDetector = new LayeringDetector(
    validatedConfig,
    logger,
    redisAdapter as never,
    alertBus as never,
  );

  const shortSellControl = new ShortSellControl(
    logger,
    alertBus as never,
  );

  const tradeReporter = new TradeReporter(
    [new LocalJsonlTradeReporter('./logs/trades.jsonl', createNodeFsAdapter())],
    logger,
    alertBus as never,
  );

  // ── Market Data Guard ──
  const feedConsensus = new FeedConsensus(
    validatedConfig,
    jwtAuditLoggerAdapter,
    redisAdapter as never,
  );

  const anomalyFilter = new AnomalyFilter(
    validatedConfig,
    jwtAuditLoggerAdapter,
    redisAdapter as never,
  );

  const feedSignatureVerifier = new FeedSignatureVerifier(
    validatedConfig,
    jwtAuditLoggerAdapter,
  );

  const marketDataGuard = new MarketDataGuard(
    validatedConfig,
    jwtAuditLoggerAdapter,
    redisAdapter as never,
    feedConsensus,
    anomalyFilter,
    feedSignatureVerifier,
  );

  // ── Anomaly Detector ──
  const strategyDriftDetector = new StrategyDriftDetector(
    { driftThreshold: 0.5, profileTtlSeconds: 30 * 24 * 60 * 60 },
    logger,
    redisAdapter as never,
  );

  const anomalyDetector = new AnomalyDetector(
    {
      velocityMaxTradesPerMinute: 50,
      highValueSpikeMultiplier: 5,
      geoImpossibilityMaxKm: 1000,
      geoImpossibilityWindowMinutes: 30,
      driftThreshold: 0.5,
    },
    logger,
    alertBus,
    strategyDriftDetector,
    redisAdapter as never,
    createNoopGeoIpAdapter(),
  );

  // ── Rate Limiter ──
  const rateLimiter = new RateLimiter(
    redisAdapter as never,
    jwtAuditLoggerAdapter,
  );

  // 9. Build middleware array
  const corsMiddleware = createCorsMiddleware(
    validatedConfig.corsAllowedOrigins,
    validatedConfig.environment,
  );

  const securityHeaders = createSecurityHeaders({
    environment: validatedConfig.environment,
  });

  const killSwitchMiddleware = killSwitch.middleware();

  const middleware: RequestHandler[] = [
    corsMiddleware as RequestHandler,
    securityHeaders as RequestHandler,
    killSwitchMiddleware as unknown as RequestHandler,
  ];

  logger.info('Security middleware stack assembled');

  // 10. Return the stack
  return {
    middleware,
    killSwitch,
    alertBus,
    riskEngine,
    auditLogger,
    forensicsService,
    inputGuard,
    outputFilter,
    confirmationGate,
    marketDataGuard,
    anomalyDetector,
    cryptoService,
    signingService,
    rateLimiter,
    jwtValidator,
    sessionBinder,
    mfaGate,
    deviceTrustService,
    tokenRotator,
    complianceServices: {
      washTradeDetector,
      layeringDetector,
      shortSellControl,
      tradeReporter,
    },
  };
}
