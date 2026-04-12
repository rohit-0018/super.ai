import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MfaGate } from './mfa.gate.js';
import type { MfaRedisAdapter, MfaAuditLogger, MfaSecretStore, MfaChallenge } from './mfa.gate.js';
import type { SecurityConfig } from '../types/config.js';
import { AgentActionType } from '../types/actions.js';
import type { AgentAction } from '../types/actions.js';
import { RiskLevel, SecurityEventType } from '../types/events.js';
import { AuthenticationError } from '../types/errors.js';

// ─── Mock otplib ────────────────────────────────────────────────────────────

const mockCheck = vi.fn();

vi.mock('otplib', () => ({
  authenticator: {
    check: (...args: unknown[]) => mockCheck(...args),
  },
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

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

function makeRedis(): MfaRedisAdapter & Record<string, ReturnType<typeof vi.fn>> {
  return {
    get: vi.fn(),
    set: vi.fn(),
    setex: vi.fn(),
    del: vi.fn(),
  };
}

function makeLogger(): MfaAuditLogger & { log: ReturnType<typeof vi.fn> } {
  return { log: vi.fn() };
}

function makeSecretStore(): MfaSecretStore & { getTotpSecret: ReturnType<typeof vi.fn> } {
  return { getTotpSecret: vi.fn().mockResolvedValue('JBSWY3DPEHPK3PXP') };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('MfaGate', () => {
  let gate: MfaGate;
  let redis: ReturnType<typeof makeRedis>;
  let logger: ReturnType<typeof makeLogger>;
  let secretStore: ReturnType<typeof makeSecretStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = makeRedis();
    logger = makeLogger();
    secretStore = makeSecretStore();
    gate = new MfaGate(makeConfig(), logger, redis, secretStore);
    redis.setex.mockResolvedValue(undefined);
    redis.del.mockResolvedValue(undefined);
  });

  describe('isRequired', () => {
    it('should require MFA for PlaceOrder actions', () => {
      const action: AgentAction = {
        type: AgentActionType.PlaceOrder,
        instrument: 'BTC-USDT',
        side: 'BUY' as never,
        orderType: 'MARKET' as never,
        quantity: 1,
        strategyId: 'strat-1',
        clientOrderId: '00000000-0000-0000-0000-000000000001',
      };
      expect(gate.isRequired(action, RiskLevel.LOW)).toBe(true);
    });

    it('should require MFA for ClosePosition actions', () => {
      const action: AgentAction = {
        type: AgentActionType.ClosePosition,
        instrument: 'ETH-USDT',
        strategyId: 'strat-1',
      };
      expect(gate.isRequired(action, RiskLevel.LOW)).toBe(true);
    });

    it('should require MFA when risk level meets threshold', () => {
      const action: AgentAction = {
        type: AgentActionType.CancelOrder,
        clientOrderId: '00000000-0000-0000-0000-000000000001',
        instrument: 'BTC-USDT',
        strategyId: 'strat-1',
      };
      expect(gate.isRequired(action, RiskLevel.HIGH)).toBe(true);
      expect(gate.isRequired(action, RiskLevel.CRITICAL)).toBe(true);
    });

    it('should not require MFA for low-risk non-high-risk actions', () => {
      const action: AgentAction = {
        type: AgentActionType.NoAction,
        reason: 'No action needed',
      };
      expect(gate.isRequired(action, RiskLevel.LOW)).toBe(false);
      expect(gate.isRequired(action, RiskLevel.MEDIUM)).toBe(false);
    });
  });

  describe('generateChallenge', () => {
    it('should generate a challenge and store it in Redis', async () => {
      const challenge = await gate.generateChallenge('user-123', 'PlaceOrder');

      expect(challenge.challengeId).toBeDefined();
      expect(challenge.userId).toBe('user-123');
      expect(challenge.action).toBe('PlaceOrder');
      expect(challenge.expiresAt - challenge.issuedAt).toBe(90);
      expect(challenge.signature).toHaveLength(64); // SHA-256 hex

      expect(redis.setex).toHaveBeenCalledWith(
        expect.stringContaining('mfa:challenge:'),
        90,
        expect.any(String),
      );

      expect(logger.log).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: SecurityEventType.MFA_REQUIRED }),
      );
    });
  });

  describe('verifyResponse', () => {
    let challenge: MfaChallenge;

    beforeEach(async () => {
      challenge = await gate.generateChallenge('user-123', 'PlaceOrder');
      redis.get.mockResolvedValue(JSON.stringify(challenge));
    });

    it('should verify a valid TOTP code and emit MFA_SUCCESS', async () => {
      mockCheck.mockReturnValue(true);

      const result = await gate.verifyResponse(challenge.challengeId, '123456', 'user-123');

      expect(result).toBe(true);
      expect(redis.del).toHaveBeenCalledWith(`mfa:challenge:${challenge.challengeId}`);
      expect(logger.log).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: SecurityEventType.MFA_SUCCESS }),
      );
    });

    it('should throw when TOTP code is invalid', async () => {
      mockCheck.mockReturnValue(false);

      await expect(gate.verifyResponse(challenge.challengeId, '000000', 'user-123'))
        .rejects.toThrow(AuthenticationError);

      expect(logger.log).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: SecurityEventType.MFA_FAILURE }),
      );
    });

    it('should throw when challenge is not found', async () => {
      redis.get.mockResolvedValue(null);

      await expect(gate.verifyResponse('nonexistent', '123456', 'user-123'))
        .rejects.toThrow(AuthenticationError);
    });

    it('should throw when challenge has expired', async () => {
      const expiredChallenge: MfaChallenge = {
        ...challenge,
        issuedAt: Math.floor(Date.now() / 1000) - 200,
        expiresAt: Math.floor(Date.now() / 1000) - 100,
      };
      redis.get.mockResolvedValue(JSON.stringify(expiredChallenge));

      await expect(gate.verifyResponse(challenge.challengeId, '123456', 'user-123'))
        .rejects.toThrow(AuthenticationError);
    });

    it('should throw when challenge belongs to a different user', async () => {
      await expect(gate.verifyResponse(challenge.challengeId, '123456', 'other-user'))
        .rejects.toThrow(AuthenticationError);
    });
  });
});
