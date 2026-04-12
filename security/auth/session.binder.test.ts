import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionBinder } from './session.binder.js';
import type { RedisAdapter, AlertBus, SessionAuditLogger, IncomingRequest } from './session.binder.js';
import type { ValidatedToken } from './jwt.validator.js';
import type { SecurityConfig } from '../types/config.js';
import { SecurityEventType } from '../types/events.js';
import { SessionError } from '../types/errors.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeConfig(): SecurityConfig {
  return {
    jwtPublicKeyPath: '/keys/public.pem',
    jwtPrivateKeyPath: '/keys/private.pem',
    accessTokenExpirySeconds: 900,
    refreshTokenExpirySeconds: 86400,
    mfaTotpIssuer: 'SuperAI',
    mfaStepUpThresholdRiskLevel: 'HIGH',
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
    hmacChainSecret: 'a'.repeat(32),
    corsAllowedOrigins: ['http://localhost:3000'],
    alertWebhookUrls: [],
    alertSlackChannel: '#security-alerts',
    encryptionKeyId: 'default-enc-key',
    signingPrivateKey: 'mock-priv',
    signingPublicKey: 'mock-pub',
    adminUserId: 'admin-1',
    environment: 'development',
  } as SecurityConfig;
}

function makeRedis(): RedisAdapter & Record<string, ReturnType<typeof vi.fn>> {
  return {
    get: vi.fn(),
    set: vi.fn(),
    setex: vi.fn(),
    del: vi.fn(),
  };
}

function makeLogger(): SessionAuditLogger & { log: ReturnType<typeof vi.fn> } {
  return { log: vi.fn() };
}

function makeAlertBus(): AlertBus & { emit: ReturnType<typeof vi.fn> } {
  return { emit: vi.fn() };
}

function makeToken(overrides: Partial<ValidatedToken> = {}): ValidatedToken {
  const now = Math.floor(Date.now() / 1000);
  return {
    userId: 'user-123',
    sessionId: 'session-456',
    scope: ['trade', 'read'],
    issuedAt: now - 60,
    expiresAt: now + 3600,
    deviceFingerprint: 'fp-abc',
    ...overrides,
  };
}

function makeRequest(overrides: Partial<IncomingRequest> = {}): IncomingRequest {
  return {
    ip: '192.168.1.1',
    userAgent: 'TestAgent/1.0',
    tlsFingerprint: 'tls-fp-xyz',
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('SessionBinder', () => {
  let binder: SessionBinder;
  let redis: ReturnType<typeof makeRedis>;
  let logger: ReturnType<typeof makeLogger>;
  let alertBus: ReturnType<typeof makeAlertBus>;

  beforeEach(() => {
    redis = makeRedis();
    logger = makeLogger();
    alertBus = makeAlertBus();
    binder = new SessionBinder(makeConfig(), logger, alertBus, redis);
    redis.setex.mockResolvedValue(undefined);
    redis.del.mockResolvedValue(undefined);
  });

  describe('bind', () => {
    it('should create a bound session and store it in Redis', async () => {
      const token = makeToken();
      const request = makeRequest();

      const session = await binder.bind(token, request);

      expect(session.sessionId).toBe('session-456');
      expect(session.userId).toBe('user-123');
      expect(session.fingerprint).toHaveLength(64); // SHA-256 hex
      expect(redis.setex).toHaveBeenCalledTimes(1);
      expect(redis.setex).toHaveBeenCalledWith(
        'session:bind:session-456',
        expect.any(Number),
        expect.any(String),
      );
    });

    it('should use minimum TTL of 60 seconds when token expiry is near', async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = makeToken({ expiresAt: now + 10 });
      const request = makeRequest();

      await binder.bind(token, request);

      const ttlArg = redis.setex.mock.calls[0]?.[1] as number;
      expect(ttlArg).toBeGreaterThanOrEqual(60);
    });
  });

  describe('verify', () => {
    it('should verify a matching session successfully', async () => {
      const token = makeToken();
      const request = makeRequest();

      // First bind
      const bound = await binder.bind(token, request);

      // Mock Redis to return the stored session
      redis.get.mockResolvedValue(JSON.stringify(bound));

      const verified = await binder.verify('session-456', request);

      expect(verified.sessionId).toBe('session-456');
      expect(verified.fingerprint).toBe(bound.fingerprint);
    });

    it('should throw SessionError when session is not found', async () => {
      redis.get.mockResolvedValue(null);

      await expect(binder.verify('nonexistent', makeRequest()))
        .rejects.toThrow(SessionError);
    });

    it('should throw SessionError and emit alerts on fingerprint mismatch', async () => {
      const token = makeToken();
      const originalRequest = makeRequest();
      const bound = await binder.bind(token, originalRequest);

      redis.get.mockResolvedValue(JSON.stringify(bound));

      const differentRequest = makeRequest({
        ip: '10.0.0.99',
        userAgent: 'EvilBrowser/1.0',
      });

      await expect(binder.verify('session-456', differentRequest))
        .rejects.toThrow(SessionError);

      expect(logger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: SecurityEventType.SESSION_MISMATCH,
        }),
      );

      expect(alertBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'CRITICAL',
          type: 'SESSION_MISMATCH',
        }),
      );
    });
  });

  describe('destroy', () => {
    it('should delete the session from Redis', async () => {
      await binder.destroy('session-456');

      expect(redis.del).toHaveBeenCalledWith('session:bind:session-456');
    });
  });
});
