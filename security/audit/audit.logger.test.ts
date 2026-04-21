import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuditLogger, NoopWriter, JsonlFileWriter } from './audit.logger.js';
import type { LogWriter, LogContext } from './audit.logger.js';
import { HmacChain } from './hmac.chain.js';
import { ResultStatus } from './log.entry.schema.js';
import type { LogEntry } from './log.entry.schema.js';
import { SecurityEventType, RiskLevel } from '../types/events.js';
import type { SecurityEvent } from '../types/events.js';
import type { SecurityConfig } from '../types/config.js';
import { CircuitBreakerState } from '../types/risk.js';

// ─── Mock fs ────────────────────────────────────────────────────────────────

vi.mock('node:fs/promises', () => ({
  appendFile: vi.fn().mockResolvedValue(undefined),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

const TEST_SECRET = 'a-very-secure-secret-that-is-at-least-32-chars-long!!';

function makeConfig(overrides: Partial<SecurityConfig> = {}): SecurityConfig {
  return {
    jwtPublicKeyPath: '/keys/public.pem',
    jwtPrivateKeyPath: '/keys/private.pem',
    accessTokenExpirySeconds: 900,
    refreshTokenExpirySeconds: 86400,
    mfaTotpIssuer: 'SuperAI',
    mfaStepUpThresholdRiskLevel: RiskLevel.HIGH,
    deviceTrustScoreThreshold: 70,
    deviceTrustScoreIncrement: 5,
    marketDataStalenessThresholdMs: 5000,
    feedConsensusDivergenceThresholdPercent: 1.5,
    feedSignaturePublicKeys: {},
    anomalyStdDevMultiplier: 3,
    anomalyWindowSize: 100,
    injectionDetectionThresholdScore: 0.7,
    piiScrubbingPatterns: [],
    approvedTradingUniverse: [],
    positionLimitsPerInstrument: {},
    portfolioNotionalLimit: 1_000_000,
    sessionDrawdownKillSwitchPercent: 10,
    velocityCircuitBreakerOrderCount: 50,
    velocityCircuitBreakerWindowSeconds: 60,
    errorRateCircuitBreakerConsecutiveRejectionCount: 5,
    tradingHoursPerMarket: { crypto: { open: '00:00', close: '23:59' } },
    highValueConfirmationThreshold: 50_000,
    washTradeDetectionWindowMs: 1000,
    layeringDetectionWindowMs: 5000,
    layeringCancelRatioThreshold: 0.8,
    rateLimitUser: { requests: 100, windowMs: 60_000 },
    rateLimitStrategy: { requests: 50, windowMs: 60_000 },
    rateLimitInstrument: { requests: 200, windowMs: 60_000 },
    rateLimitExchange: { requests: 1000, windowMs: 60_000 },
    redisUrl: 'redis://localhost:6379',
    kmsKeyArn: '',
    kmsProvider: 'local',
    secretsRotationPollIntervalSeconds: 300,
    deadManSwitchHeartbeatTimeoutSeconds: 120,
    auditLogOutputPath: './logs/audit.jsonl',
    hmacChainSecret: TEST_SECRET,
    corsAllowedOrigins: ['http://localhost:3001'],
    alertWebhookUrls: [],
    alertSlackChannel: '#security-alerts',
    encryptionKeyId: 'default-enc-key',
    signingPrivateKey: 'mock-private-key',
    signingPublicKey: 'mock-public-key',
    adminUserId: 'admin-1',
    environment: 'development',
    ...overrides,
  } as SecurityConfig;
}

function makeEvent(overrides: Partial<SecurityEvent> = {}): SecurityEvent {
  return {
    eventType: SecurityEventType.ACTION_ALLOWED,
    timestamp: '2026-04-12T10:00:00.000Z',
    correlationId: 'corr-001',
    riskLevel: RiskLevel.LOW,
    payload: {
      actionType: 'place_order',
      strategyId: 'strategy-1',
      instrument: 'BTC-USDT',
      checksPerformed: ['universe', 'position_limit'],
    },
    ...overrides,
  } as SecurityEvent;
}

function makeContext(overrides: Partial<LogContext> = {}): LogContext {
  return {
    correlationId: 'corr-001',
    userId: 'user-1',
    sessionId: 'session-1',
    strategyId: 'strategy-1',
    latencyMs: 42,
    circuitBreakerStates: [
      {
        name: 'velocity',
        state: CircuitBreakerState.CLOSED,
        threshold: 50,
        currentCount: 3,
        lastStateChange: '2026-04-12T09:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

// ─── Spy Writer ─────────────────────────────────────────────────────────────

class SpyWriter implements LogWriter {
  public entries: LogEntry[] = [];
  async write(entry: LogEntry): Promise<void> {
    this.entries.push(entry);
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('AuditLogger', () => {
  let config: SecurityConfig;
  let hmacChain: HmacChain;
  let spy: SpyWriter;
  let logger: AuditLogger;

  beforeEach(() => {
    config = makeConfig();
    hmacChain = new HmacChain(TEST_SECRET);
    spy = new SpyWriter();
    logger = new AuditLogger(config, hmacChain, spy);
  });

  describe('log', () => {
    it('should write a valid log entry', async () => {
      await logger.log(makeEvent(), makeContext());

      expect(spy.entries).toHaveLength(1);
      const entry = spy.entries[0]!;
      expect(entry.correlationId).toBe('corr-001');
      expect(entry.userId).toBe('user-1');
      expect(entry.sessionId).toBe('session-1');
      expect(entry.eventType).toBe(SecurityEventType.ACTION_ALLOWED);
      expect(entry.actionName).toBe('place_order');
      expect(entry.latencyMs).toBe(42);
      expect(entry.resultStatus).toBe(ResultStatus.SUCCESS);
      expect(entry.entryHmac).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should produce a verifiable HMAC', async () => {
      await logger.log(makeEvent(), makeContext());

      const entry = spy.entries[0]!;
      expect(hmacChain.verify(entry)).toBe(true);
    });

    it('should chain HMACs across multiple entries', async () => {
      await logger.log(makeEvent(), makeContext());
      await logger.log(
        makeEvent({ eventType: SecurityEventType.ACTION_BLOCKED } as Partial<SecurityEvent>),
        makeContext({ correlationId: 'corr-002' }),
      );

      expect(spy.entries).toHaveLength(2);
      const [entry1, entry2] = spy.entries as [LogEntry, LogEntry];
      expect(entry2.previousEntryHmac).toBe(entry1.entryHmac);

      const chainResult = hmacChain.verifyChain(spy.entries);
      expect(chainResult.valid).toBe(true);
    });

    it('should derive FAILURE status for failure events', async () => {
      await logger.log(
        makeEvent({
          eventType: SecurityEventType.AUTH_FAILURE,
          payload: {
            ip: '1.2.3.4',
            userAgent: 'test',
            reason: 'bad creds',
            attemptCount: 1,
          },
        } as unknown as Partial<SecurityEvent>),
        makeContext(),
      );

      const entry = spy.entries[0]!;
      expect(entry.resultStatus).toBe(ResultStatus.FAILURE);
    });

    it('should derive BLOCKED status for blocked events', async () => {
      await logger.log(
        makeEvent({
          eventType: SecurityEventType.ACTION_BLOCKED,
          payload: {
            actionType: 'place_order',
            strategyId: 'strat-1',
            reason: 'limit breached',
            violatedRule: 'position_limit',
          },
        } as unknown as Partial<SecurityEvent>),
        makeContext(),
      );

      const entry = spy.entries[0]!;
      expect(entry.resultStatus).toBe(ResultStatus.BLOCKED);
    });

    it('should derive WARNING status for warning events', async () => {
      await logger.log(
        makeEvent({
          eventType: SecurityEventType.EXCHANGE_QUOTA_WARNING,
          payload: {
            exchange: 'binance',
            usedPercent: 85,
            remainingRequests: 150,
            resetAtMs: Date.now() + 60000,
          },
        } as unknown as Partial<SecurityEvent>),
        makeContext(),
      );

      const entry = spy.entries[0]!;
      expect(entry.resultStatus).toBe(ResultStatus.WARNING);
    });

    it('should not throw on writer failure and write to stderr', async () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const failingWriter: LogWriter = {
        async write(): Promise<void> {
          throw new Error('disk full');
        },
      };

      const failLogger = new AuditLogger(config, hmacChain, failingWriter);
      // Should NOT throw
      await expect(failLogger.log(makeEvent(), makeContext())).resolves.toBeUndefined();
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('disk full'),
      );
      stderrSpy.mockRestore();
    });

    it('should include circuit breaker states from context', async () => {
      await logger.log(makeEvent(), makeContext());

      const entry = spy.entries[0]!;
      expect(entry.circuitBreakerStates).toHaveLength(1);
      expect(entry.circuitBreakerStates[0]!.name).toBe('velocity');
    });
  });

  describe('getCorrelationId', () => {
    it('should return a valid UUID', () => {
      const id = AuditLogger.getCorrelationId();
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it('should return unique IDs', () => {
      const id1 = AuditLogger.getCorrelationId();
      const id2 = AuditLogger.getCorrelationId();
      expect(id1).not.toBe(id2);
    });
  });

  describe('NoopWriter', () => {
    it('should accept writes without error', async () => {
      const noop = new NoopWriter();
      const entry = spy.entries[0];
      // Write a fabricated entry
      await expect(
        noop.write({
          id: '550e8400-e29b-41d4-a716-446655440000',
          correlationId: 'corr',
          timestamp: '2026-04-12T10:00:00.000Z',
          eventType: SecurityEventType.ACTION_ALLOWED,
          parameters: {},
          resultStatus: ResultStatus.SUCCESS,
          latencyMs: 0,
          circuitBreakerStates: [],
          systemPromptHash: 'hash',
          previousEntryHmac: '0'.repeat(64),
          entryHmac: 'a'.repeat(64),
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('JsonlFileWriter', () => {
    it('should call appendFile with JSON line', async () => {
      const { appendFile: mockAppend } = await import('node:fs/promises');
      const writer = new JsonlFileWriter('/tmp/test-audit.jsonl');

      const testEntry: LogEntry = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        correlationId: 'corr',
        timestamp: '2026-04-12T10:00:00.000Z',
        eventType: SecurityEventType.ACTION_ALLOWED,
        parameters: {},
        resultStatus: ResultStatus.SUCCESS,
        latencyMs: 0,
        circuitBreakerStates: [],
        systemPromptHash: 'hash',
        previousEntryHmac: '0'.repeat(64),
        entryHmac: 'a'.repeat(64),
      };

      await writer.write(testEntry);
      expect(mockAppend).toHaveBeenCalledWith(
        '/tmp/test-audit.jsonl',
        JSON.stringify(testEntry) + '\n',
        'utf-8',
      );
    });
  });
});
