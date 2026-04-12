import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TokenRotator } from './token.rotator.js';
import type { TokenRotatorRedisAdapter } from './token.rotator.js';
import type { AuditLogger } from './jwt.validator.js';
import { JwtValidator } from './jwt.validator.js';
import type { SecurityConfig } from '../types/config.js';
import { AuthenticationError } from '../types/errors.js';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockJwtVerify = vi.fn();
const mockImportSPKI = vi.fn();

vi.mock('jose', () => ({
  jwtVerify: (...args: unknown[]) => mockJwtVerify(...args),
  importSPKI: (...args: unknown[]) => mockImportSPKI(...args),
  importPKCS8: vi.fn().mockResolvedValue(Symbol('privateKey')),
  SignJWT: vi.fn().mockImplementation(() => ({
    setProtectedHeader: vi.fn().mockReturnThis(),
    setIssuedAt: vi.fn().mockReturnThis(),
    setExpirationTime: vi.fn().mockReturnThis(),
    sign: vi.fn().mockResolvedValue('new-mock-jwt'),
  })),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('-----BEGIN PUBLIC KEY-----\nMOCK\n-----END PUBLIC KEY-----'),
}));

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

function makeRedis(): TokenRotatorRedisAdapter & Record<string, ReturnType<typeof vi.fn>> {
  return {
    get: vi.fn(),
    set: vi.fn(),
    setex: vi.fn(),
    del: vi.fn(),
  };
}

function makeLogger(): AuditLogger & { log: ReturnType<typeof vi.fn> } {
  return { log: vi.fn() };
}

function validRefreshPayload(): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: 'user-123',
    sid: 'session-456',
    scope: ['refresh'],
    iat: now - 60,
    exp: now + 86400,
    dfp: 'fp-abc',
    jti: 'jti-unique-id',
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('TokenRotator', () => {
  let rotator: TokenRotator;
  let redis: ReturnType<typeof makeRedis>;
  let logger: ReturnType<typeof makeLogger>;
  let jwtValidator: JwtValidator;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = makeRedis();
    logger = makeLogger();
    const config = makeConfig();
    jwtValidator = new JwtValidator(config, logger);
    rotator = new TokenRotator(config, redis, jwtValidator, logger);

    mockImportSPKI.mockResolvedValue(Symbol('publicKey'));
    redis.setex.mockResolvedValue(undefined);
    redis.set.mockResolvedValue(undefined);
    redis.del.mockResolvedValue(undefined);
  });

  it('should rotate a valid refresh token and return new token pair', async () => {
    const payload = validRefreshPayload();
    mockJwtVerify.mockResolvedValue({ payload, protectedHeader: { alg: 'RS256' } });
    redis.get.mockResolvedValue(null); // not used yet

    const result = await rotator.rotate('valid-refresh-token');

    expect(result.accessToken).toBe('new-mock-jwt');
    expect(result.refreshToken).toBe('new-mock-jwt');
    expect(redis.setex).toHaveBeenCalledWith(
      'refresh:used:jti-unique-id',
      86400,
      expect.any(String),
    );
  });

  it('should detect replay attack when refresh token is already used', async () => {
    const payload = validRefreshPayload();
    mockJwtVerify.mockResolvedValue({ payload, protectedHeader: { alg: 'RS256' } });
    redis.get.mockResolvedValue('2026-01-01T00:00:00.000Z'); // already used

    await expect(rotator.rotate('replayed-refresh-token'))
      .rejects.toThrow(AuthenticationError);

    await expect(rotator.rotate('replayed-refresh-token'))
      .rejects.toThrow(/replay/i);

    // Should log failure
    expect(logger.log).toHaveBeenCalled();
  });

  it('should reject a refresh token with invalid signature', async () => {
    mockJwtVerify.mockRejectedValue(new Error('signature verification failed'));

    await expect(rotator.rotate('tampered-refresh-token'))
      .rejects.toThrow(AuthenticationError);
  });

  it('should reject a refresh token without jti claim', async () => {
    const payload = validRefreshPayload();
    delete payload.jti;
    mockJwtVerify.mockResolvedValue({ payload, protectedHeader: { alg: 'RS256' } });
    redis.get.mockResolvedValue(null);

    await expect(rotator.rotate('no-jti-refresh-token'))
      .rejects.toThrow(AuthenticationError);
  });

  it('should invalidate token family on replay detection', async () => {
    const payload = { ...validRefreshPayload(), fid: 'family-1' };
    mockJwtVerify.mockResolvedValue({ payload, protectedHeader: { alg: 'RS256' } });
    redis.get.mockResolvedValue('used');

    await expect(rotator.rotate('replayed')).rejects.toThrow(AuthenticationError);

    expect(redis.del).toHaveBeenCalledWith('refresh:family:family-1');
  });
});
