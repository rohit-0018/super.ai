import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JwtValidator } from './jwt.validator.js';
import type { AuditLogger } from './jwt.validator.js';
import type { SecurityConfig } from '../types/config.js';
import { SecurityEventType } from '../types/events.js';
import { AuthenticationError } from '../types/errors.js';
import { SecurityErrorCode } from '../types/errors.js';

// ─── Mock jose ──────────────────────────────────────────────────────────────

const mockJwtVerify = vi.fn();
const mockImportSPKI = vi.fn();
const mockImportPKCS8 = vi.fn();

vi.mock('jose', () => ({
  jwtVerify: (...args: unknown[]) => mockJwtVerify(...args),
  importSPKI: (...args: unknown[]) => mockImportSPKI(...args),
  importPKCS8: (...args: unknown[]) => mockImportPKCS8(...args),
  SignJWT: vi.fn().mockImplementation(() => {
    const builder = {
      setProtectedHeader: vi.fn().mockReturnThis(),
      setIssuedAt: vi.fn().mockReturnThis(),
      setExpirationTime: vi.fn().mockReturnThis(),
      sign: vi.fn().mockResolvedValue('mock-signed-jwt'),
    };
    return builder;
  }),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('-----BEGIN PUBLIC KEY-----\nMOCK\n-----END PUBLIC KEY-----'),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<SecurityConfig> = {}): SecurityConfig {
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
    ...overrides,
  } as SecurityConfig;
}

function makeLogger(): AuditLogger & { log: ReturnType<typeof vi.fn> } {
  return { log: vi.fn() };
}

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: 'user-123',
    sid: 'session-456',
    scope: ['trade', 'read'],
    iat: now - 60,
    exp: now + 3600,
    dfp: 'fp-abc',
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('JwtValidator', () => {
  let validator: JwtValidator;
  let logger: ReturnType<typeof makeLogger>;
  const fakePublicKey = Symbol('publicKey');

  beforeEach(() => {
    vi.clearAllMocks();
    logger = makeLogger();
    validator = new JwtValidator(makeConfig(), logger);
    mockImportSPKI.mockResolvedValue(fakePublicKey);
    mockImportPKCS8.mockResolvedValue(Symbol('privateKey'));
  });

  it('should validate a valid token and emit AUTH_SUCCESS', async () => {
    const payload = validPayload();
    mockJwtVerify.mockResolvedValue({ payload, protectedHeader: { alg: 'RS256' } });

    const result = await validator.validate('valid-token', 'trade');

    expect(result.userId).toBe('user-123');
    expect(result.sessionId).toBe('session-456');
    expect(result.scope).toContain('trade');
    expect(result.deviceFingerprint).toBe('fp-abc');
    expect(mockJwtVerify).toHaveBeenCalledWith('valid-token', fakePublicKey, { algorithms: ['RS256'] });
    expect(logger.log).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: SecurityEventType.AUTH_SUCCESS }),
    );
  });

  it('should reject an expired token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const payload = validPayload({ exp: now - 100 });
    mockJwtVerify.mockResolvedValue({ payload, protectedHeader: { alg: 'RS256' } });

    await expect(validator.validate('expired-token', 'trade'))
      .rejects.toThrow(AuthenticationError);

    expect(logger.log).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: SecurityEventType.AUTH_FAILURE }),
    );
  });

  it('should reject a token missing the required scope', async () => {
    const payload = validPayload({ scope: ['read'] });
    mockJwtVerify.mockResolvedValue({ payload, protectedHeader: { alg: 'RS256' } });

    await expect(validator.validate('no-scope-token', 'trade'))
      .rejects.toThrow(AuthenticationError);

    const call = logger.log.mock.calls.find(
      (c: Array<Record<string, unknown>>) =>
        (c[0] as Record<string, unknown>).eventType === SecurityEventType.AUTH_FAILURE,
    );
    expect(call).toBeDefined();
  });

  it('should reject a tampered / invalid signature token', async () => {
    mockJwtVerify.mockRejectedValue(new Error('signature verification failed'));

    await expect(validator.validate('tampered-token', 'trade'))
      .rejects.toThrow(AuthenticationError);

    expect(logger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: SecurityEventType.AUTH_FAILURE,
        payload: expect.objectContaining({
          reason: 'signature verification failed',
        }),
      }),
    );
  });

  it('should reject a token with missing fields (Zod validation failure)', async () => {
    const payload = { sub: 'user-123' }; // missing sid, scope, etc.
    mockJwtVerify.mockResolvedValue({ payload, protectedHeader: { alg: 'RS256' } });

    await expect(validator.validate('incomplete-token', 'trade'))
      .rejects.toThrow(AuthenticationError);

    expect(logger.log).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: SecurityEventType.AUTH_FAILURE }),
    );
  });

  it('should generate an access token', async () => {
    const token = await validator.generateAccessToken('user-1', 'sess-1', ['trade'], 'fp-1');
    expect(token).toBe('mock-signed-jwt');
  });

  it('should generate a refresh token', async () => {
    const token = await validator.generateRefreshToken('user-1', 'sess-1', 'fp-1');
    expect(token).toBe('mock-signed-jwt');
  });
});
