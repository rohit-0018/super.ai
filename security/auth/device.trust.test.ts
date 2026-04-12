import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeviceTrustService } from './device.trust.js';
import type { DeviceTrustRedisAdapter } from './device.trust.js';
import { AgentActionType } from '../types/actions.js';
import type { AgentAction } from '../types/actions.js';
import type { SecurityConfig } from '../types/config.js';

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

function makeRedis(): DeviceTrustRedisAdapter & Record<string, ReturnType<typeof vi.fn>> {
  return {
    get: vi.fn(),
    set: vi.fn(),
    setex: vi.fn(),
    del: vi.fn(),
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('DeviceTrustService', () => {
  let service: DeviceTrustService;
  let redis: ReturnType<typeof makeRedis>;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = makeRedis();
    service = new DeviceTrustService(makeConfig(), redis);
    redis.setex.mockResolvedValue(undefined);
    redis.del.mockResolvedValue(undefined);
  });

  describe('getScore', () => {
    it('should return 0 for unknown devices', async () => {
      redis.get.mockResolvedValue(null);

      const score = await service.getScore('user-1', 'fp-unknown');

      expect(score).toBe(0);
      expect(redis.get).toHaveBeenCalledWith('device:trust:user-1:fp-unknown');
    });

    it('should return the stored score', async () => {
      redis.get.mockResolvedValue('85');

      const score = await service.getScore('user-1', 'fp-known');

      expect(score).toBe(85);
    });

    it('should cap score at 100', async () => {
      redis.get.mockResolvedValue('150');

      const score = await service.getScore('user-1', 'fp-over');

      expect(score).toBe(100);
    });

    it('should return 0 for invalid stored values', async () => {
      redis.get.mockResolvedValue('not-a-number');

      const score = await service.getScore('user-1', 'fp-bad');

      expect(score).toBe(0);
    });
  });

  describe('recordSuccessfulAuth', () => {
    it('should increment score by configured increment', async () => {
      redis.get.mockResolvedValue('50');

      const newScore = await service.recordSuccessfulAuth('user-1', 'fp-1');

      expect(newScore).toBe(55);
      expect(redis.setex).toHaveBeenCalledWith(
        'device:trust:user-1:fp-1',
        expect.any(Number),
        '55',
      );
    });

    it('should cap score at 100', async () => {
      redis.get.mockResolvedValue('98');

      const newScore = await service.recordSuccessfulAuth('user-1', 'fp-1');

      expect(newScore).toBe(100);
    });

    it('should start from 0 for new devices', async () => {
      redis.get.mockResolvedValue(null);

      const newScore = await service.recordSuccessfulAuth('user-1', 'fp-new');

      expect(newScore).toBe(5);
    });

    it('should use custom increment from config', async () => {
      redis.get.mockResolvedValue('0');
      const customService = new DeviceTrustService(
        makeConfig({ deviceTrustScoreIncrement: 20 }),
        redis,
      );

      const newScore = await customService.recordSuccessfulAuth('user-1', 'fp-1');

      expect(newScore).toBe(20);
    });
  });

  describe('isActionPermitted', () => {
    it('should permit NoAction for any score', () => {
      const action: AgentAction = {
        type: AgentActionType.NoAction,
        reason: 'idle',
      };
      expect(service.isActionPermitted(0, action)).toBe(true);
    });

    it('should permit RequestHumanReview for any score', () => {
      const action: AgentAction = {
        type: AgentActionType.RequestHumanReview,
        reason: 'Need review',
        context: {},
        strategyId: 'strat-1',
      };
      expect(service.isActionPermitted(0, action)).toBe(true);
    });

    it('should deny PlaceOrder for low score', () => {
      const action: AgentAction = {
        type: AgentActionType.PlaceOrder,
        instrument: 'BTC-USDT',
        side: 'BUY' as never,
        orderType: 'MARKET' as never,
        quantity: 1,
        strategyId: 'strat-1',
        clientOrderId: '00000000-0000-0000-0000-000000000001',
      };
      expect(service.isActionPermitted(50, action)).toBe(false);
    });

    it('should permit PlaceOrder for high score', () => {
      const action: AgentAction = {
        type: AgentActionType.PlaceOrder,
        instrument: 'BTC-USDT',
        side: 'BUY' as never,
        orderType: 'MARKET' as never,
        quantity: 1,
        strategyId: 'strat-1',
        clientOrderId: '00000000-0000-0000-0000-000000000001',
      };
      expect(service.isActionPermitted(80, action)).toBe(true);
    });

    it('should deny CancelOrder when score is below config threshold', () => {
      // CancelOrder action threshold is 30, but config threshold is 70
      // For actions with threshold > 0, uses max(action, config) = 70
      const action: AgentAction = {
        type: AgentActionType.CancelOrder,
        clientOrderId: '00000000-0000-0000-0000-000000000001',
        instrument: 'BTC-USDT',
        strategyId: 'strat-1',
      };
      expect(service.isActionPermitted(50, action)).toBe(false);
    });
  });

  describe('revokeDevice', () => {
    it('should delete the device trust score from Redis', async () => {
      await service.revokeDevice('user-1', 'fp-revoke');

      expect(redis.del).toHaveBeenCalledWith('device:trust:user-1:fp-revoke');
    });
  });
});
