import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  ApprovalFlow,
  ConfirmationExpiredError,
  ConfirmationReplayError,
  ConfirmationOwnershipError,
  ConfirmationSignatureError,
} from './approval.flow.js';
import type { RedisAdapter, Logger, ApprovalChallenge } from './approval.flow.js';
import type { SecurityConfig } from '../types/config.js';
import { AgentActionType, OrderSide, OrderType } from '../types/actions.js';
import type { PlaceOrderAction } from '../types/actions.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

const HMAC_SECRET = 'a]9$Kz!mP2wQ8rT5vX0bN3gF6jL1dH4e';

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
    hmacChainSecret: HMAC_SECRET,
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

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeRedisAdapter(): RedisAdapter & {
  _store: Map<string, { value: string; ttl: number }>;
} {
  const store = new Map<string, { value: string; ttl: number }>();
  return {
    _store: store,
    get: vi.fn(async (key: string): Promise<string | null> => {
      const entry = store.get(key);
      return entry?.value ?? null;
    }),
    set: vi.fn(async (key: string, value: string, ttlSeconds: number): Promise<void> => {
      store.set(key, { value, ttl: ttlSeconds });
    }),
    del: vi.fn(async (key: string): Promise<void> => {
      store.delete(key);
    }),
  };
}

function makePlaceOrderAction(): PlaceOrderAction {
  return {
    type: AgentActionType.PlaceOrder,
    instrument: 'BTC-USDT',
    side: OrderSide.BUY,
    orderType: OrderType.LIMIT,
    quantity: 1,
    price: 60000,
    strategyId: 'strat-1',
    clientOrderId: '550e8400-e29b-41d4-a716-446655440000',
  };
}

function computeApprovalSignature(
  challengeId: string,
  userId: string,
  secret: string,
): string {
  const data = `approve:${challengeId}:${userId}`;
  return createHmac('sha256', secret).update(data).digest('hex');
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('ApprovalFlow', () => {
  let config: SecurityConfig;
  let logger: Logger;
  let redis: ReturnType<typeof makeRedisAdapter>;
  let flow: ApprovalFlow;

  beforeEach(() => {
    config = makeConfig();
    logger = makeLogger();
    redis = makeRedisAdapter();
    flow = new ApprovalFlow(config, logger, redis);
  });

  describe('createChallenge', () => {
    it('creates a challenge and stores it in Redis', async () => {
      const action = makePlaceOrderAction();
      const challenge = await flow.createChallenge(action, 'user-1', 'session-1');

      expect(challenge.challengeId).toBeTruthy();
      expect(challenge.userId).toBe('user-1');
      expect(challenge.sessionId).toBe('session-1');
      expect(challenge.actionPayload).toBe(JSON.stringify(action));
      expect(challenge.signature).toBeTruthy();
      expect(challenge.createdAt).toBeTruthy();
      expect(challenge.expiresAt).toBeTruthy();

      // Verify stored in Redis
      expect(redis.set).toHaveBeenCalledOnce();
      const storedKey = (redis.set as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
      expect(storedKey).toContain(challenge.challengeId);
    });

    it('sets an HMAC-SHA256 signature on the challenge', async () => {
      const action = makePlaceOrderAction();
      const challenge = await flow.createChallenge(action, 'user-1', 'session-1');

      // Signature must be a 64-char hex string (SHA-256)
      expect(challenge.signature).toMatch(/^[a-f0-9]{64}$/);
    });

    it('sets expiresAt in the future', async () => {
      const action = makePlaceOrderAction();
      const before = Date.now();
      const challenge = await flow.createChallenge(action, 'user-1', 'session-1');
      const expiresMs = new Date(challenge.expiresAt).getTime();

      expect(expiresMs).toBeGreaterThan(before);
      // Should be roughly 300 seconds in the future (allow 5s tolerance)
      expect(expiresMs - before).toBeGreaterThan(295_000);
      expect(expiresMs - before).toBeLessThan(305_000);
    });
  });

  describe('submitApproval', () => {
    it('approves a valid challenge and returns ApprovedAction', async () => {
      const action = makePlaceOrderAction();
      const challenge = await flow.createChallenge(action, 'user-1', 'session-1');
      const sig = computeApprovalSignature(challenge.challengeId, 'user-1', HMAC_SECRET);

      const result = await flow.submitApproval(challenge.challengeId, 'user-1', sig);

      expect(result.challengeId).toBe(challenge.challengeId);
      expect(result.userId).toBe('user-1');
      expect(result.action).toEqual(action);
      expect(result.approvedAt).toBeTruthy();
    });

    it('marks the challenge as consumed after approval', async () => {
      const action = makePlaceOrderAction();
      const challenge = await flow.createChallenge(action, 'user-1', 'session-1');
      const sig = computeApprovalSignature(challenge.challengeId, 'user-1', HMAC_SECRET);

      await flow.submitApproval(challenge.challengeId, 'user-1', sig);

      // The original challenge key should be deleted
      const challengeStored = redis._store.get(`confirmation:challenge:${challenge.challengeId}`);
      expect(challengeStored).toBeUndefined();

      // A consumed marker should exist
      const consumedStored = redis._store.get(`confirmation:consumed:${challenge.challengeId}`);
      expect(consumedStored).toBeDefined();
      expect(consumedStored?.value).toBe('consumed');
    });
  });

  describe('expired challenge', () => {
    it('throws ConfirmationExpiredError for a missing (TTL-expired) challenge', async () => {
      const sig = computeApprovalSignature('nonexistent-id', 'user-1', HMAC_SECRET);

      await expect(
        flow.submitApproval('nonexistent-id', 'user-1', sig),
      ).rejects.toThrow(ConfirmationExpiredError);
    });

    it('throws ConfirmationExpiredError when expiresAt is in the past', async () => {
      const action = makePlaceOrderAction();
      const challenge = await flow.createChallenge(action, 'user-1', 'session-1');

      // Manually override the stored challenge to have an expired expiresAt
      const stored = JSON.parse(
        redis._store.get(`confirmation:challenge:${challenge.challengeId}`)?.value ?? '{}',
      ) as ApprovalChallenge;
      const expired: ApprovalChallenge = {
        ...stored,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      };
      redis._store.set(`confirmation:challenge:${challenge.challengeId}`, {
        value: JSON.stringify(expired),
        ttl: 300,
      });

      const sig = computeApprovalSignature(challenge.challengeId, 'user-1', HMAC_SECRET);

      await expect(
        flow.submitApproval(challenge.challengeId, 'user-1', sig),
      ).rejects.toThrow(ConfirmationExpiredError);
    });
  });

  describe('wrong user', () => {
    it('throws ConfirmationOwnershipError when userId does not match', async () => {
      const action = makePlaceOrderAction();
      const challenge = await flow.createChallenge(action, 'user-1', 'session-1');
      const sig = computeApprovalSignature(challenge.challengeId, 'user-2', HMAC_SECRET);

      await expect(
        flow.submitApproval(challenge.challengeId, 'user-2', sig),
      ).rejects.toThrow(ConfirmationOwnershipError);
    });
  });

  describe('replay attempt', () => {
    it('throws ConfirmationReplayError on second submission', async () => {
      const action = makePlaceOrderAction();
      const challenge = await flow.createChallenge(action, 'user-1', 'session-1');
      const sig = computeApprovalSignature(challenge.challengeId, 'user-1', HMAC_SECRET);

      // First approval succeeds
      await flow.submitApproval(challenge.challengeId, 'user-1', sig);

      // Second attempt is a replay
      await expect(
        flow.submitApproval(challenge.challengeId, 'user-1', sig),
      ).rejects.toThrow(ConfirmationReplayError);
    });
  });

  describe('invalid signature', () => {
    it('throws ConfirmationSignatureError for a bad approval signature', async () => {
      const action = makePlaceOrderAction();
      const challenge = await flow.createChallenge(action, 'user-1', 'session-1');

      await expect(
        flow.submitApproval(challenge.challengeId, 'user-1', 'deadbeef'.repeat(8)),
      ).rejects.toThrow(ConfirmationSignatureError);
    });

    it('throws ConfirmationSignatureError for a signature with wrong length', async () => {
      const action = makePlaceOrderAction();
      const challenge = await flow.createChallenge(action, 'user-1', 'session-1');

      await expect(
        flow.submitApproval(challenge.challengeId, 'user-1', 'tooshort'),
      ).rejects.toThrow(ConfirmationSignatureError);
    });
  });
});
