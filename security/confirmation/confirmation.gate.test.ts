import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfirmationGate } from './confirmation.gate.js';
import type { RiskEvaluation, EnforcementResult } from './confirmation.gate.js';
import type { ApprovalFlow, ApprovalChallenge } from './approval.flow.js';
import type { SecurityConfig } from '../types/config.js';
import { AgentActionType, OrderSide, OrderType } from '../types/actions.js';
import type { AgentAction, PlaceOrderAction, CancelOrderAction, NoAction } from '../types/actions.js';
import { RiskLevel } from '../types/events.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

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
    corsAllowedOrigins: ['http://localhost:3001'],
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

function makeMockApprovalFlow(): {
  instance: ApprovalFlow;
  createChallenge: ReturnType<typeof vi.fn>;
} {
  const createChallenge = vi.fn();
  const instance = {
    createChallenge,
    submitApproval: vi.fn(),
  } as unknown as ApprovalFlow;
  return { instance, createChallenge };
}

function makePlaceOrder(overrides: Partial<PlaceOrderAction> = {}): PlaceOrderAction {
  return {
    type: AgentActionType.PlaceOrder,
    instrument: 'BTC-USDT',
    side: OrderSide.BUY,
    orderType: OrderType.LIMIT,
    quantity: 1,
    price: 60000,
    strategyId: 'strat-1',
    clientOrderId: '550e8400-e29b-41d4-a716-446655440000',
    ...overrides,
  };
}

function makeCancelOrder(): CancelOrderAction {
  return {
    type: AgentActionType.CancelOrder,
    clientOrderId: '550e8400-e29b-41d4-a716-446655440000',
    instrument: 'BTC-USDT',
    strategyId: 'strat-1',
  };
}

function makeNoAction(): NoAction {
  return {
    type: AgentActionType.NoAction,
    reason: 'No signal',
  };
}

function lowRiskEval(): RiskEvaluation {
  return { approved: true, riskLevel: RiskLevel.LOW, blockReasons: [] };
}

function mediumRiskEval(): RiskEvaluation {
  return { approved: true, riskLevel: RiskLevel.MEDIUM, blockReasons: [] };
}

function highRiskEval(): RiskEvaluation {
  return { approved: false, riskLevel: RiskLevel.HIGH, blockReasons: ['high risk'] };
}

function criticalRiskEval(): RiskEvaluation {
  return { approved: false, riskLevel: RiskLevel.CRITICAL, blockReasons: ['critical risk'] };
}

function makeChallenge(): ApprovalChallenge {
  return {
    challengeId: '11111111-1111-1111-1111-111111111111',
    userId: 'user-1',
    sessionId: 'session-1',
    actionPayload: '{}',
    signature: 'sig',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('ConfirmationGate', () => {
  let config: SecurityConfig;
  let mockFlow: ReturnType<typeof makeMockApprovalFlow>;
  let gate: ConfirmationGate;

  beforeEach(() => {
    config = makeConfig();
    mockFlow = makeMockApprovalFlow();
    gate = new ConfirmationGate(config, mockFlow.instance);
  });

  describe('evaluate', () => {
    it('returns true for HIGH risk regardless of action type', () => {
      const action = makeNoAction();
      expect(gate.evaluate(action, highRiskEval())).toBe(true);
    });

    it('returns true for CRITICAL risk regardless of action type', () => {
      const action = makeCancelOrder();
      expect(gate.evaluate(action, criticalRiskEval())).toBe(true);
    });

    it('returns false for LOW risk with a small PlaceOrder', () => {
      const action = makePlaceOrder({ quantity: 0.1, price: 100 }); // notional = 10
      expect(gate.evaluate(action, lowRiskEval())).toBe(false);
    });

    it('returns false for MEDIUM risk with a small PlaceOrder', () => {
      const action = makePlaceOrder({ quantity: 0.1, price: 100 });
      expect(gate.evaluate(action, mediumRiskEval())).toBe(false);
    });

    it('returns true for PlaceOrder with notional exceeding threshold', () => {
      // notional = 2 * 60000 = 120000 > 50000
      const action = makePlaceOrder({ quantity: 2, price: 60000 });
      expect(gate.evaluate(action, lowRiskEval())).toBe(true);
    });

    it('returns true for PlaceOrder at exact threshold boundary (notional > threshold)', () => {
      // notional = 50001 > 50000
      const action = makePlaceOrder({ quantity: 1, price: 50001 });
      expect(gate.evaluate(action, lowRiskEval())).toBe(true);
    });

    it('returns false for PlaceOrder at exact threshold (notional == threshold)', () => {
      // notional = 50000 == 50000 (not greater than)
      const action = makePlaceOrder({ quantity: 1, price: 50000 });
      expect(gate.evaluate(action, lowRiskEval())).toBe(false);
    });

    it('returns false for non-PlaceOrder actions at LOW risk', () => {
      const action = makeCancelOrder();
      expect(gate.evaluate(action, lowRiskEval())).toBe(false);
    });

    it('returns false for NoAction at LOW risk', () => {
      const action = makeNoAction();
      expect(gate.evaluate(action, lowRiskEval())).toBe(false);
    });

    it('returns false for PlaceOrder without price (market order, price undefined)', () => {
      const action = makePlaceOrder({
        orderType: OrderType.MARKET,
        price: undefined,
        quantity: 100,
      });
      // notional = 100 * 0 = 0, below threshold
      expect(gate.evaluate(action, lowRiskEval())).toBe(false);
    });

    it('respects custom highValueConfirmationThreshold from config', () => {
      const customConfig = makeConfig({ highValueConfirmationThreshold: 10_000 });
      const customGate = new ConfirmationGate(customConfig, mockFlow.instance);

      // notional = 1 * 15000 = 15000 > 10000
      const action = makePlaceOrder({ quantity: 1, price: 15000 });
      expect(customGate.evaluate(action, lowRiskEval())).toBe(true);
    });
  });

  describe('enforce', () => {
    it('returns { required: false } when no confirmation is needed', async () => {
      const action = makePlaceOrder({ quantity: 0.001, price: 100 }); // notional = 0.1
      const result = await gate.enforce(action, 'user-1', 'session-1');

      expect(result.required).toBe(false);
      expect(mockFlow.createChallenge).not.toHaveBeenCalled();
    });

    it('returns { required: true, challenge } when notional exceeds threshold', async () => {
      const challenge = makeChallenge();
      mockFlow.createChallenge.mockResolvedValue(challenge);

      const action = makePlaceOrder({ quantity: 2, price: 60000 }); // 120000 > 50000
      const result = await gate.enforce(action, 'user-1', 'session-1');

      expect(result.required).toBe(true);
      if (result.required) {
        expect(result.challenge).toBe(challenge);
      }
      expect(mockFlow.createChallenge).toHaveBeenCalledWith(action, 'user-1', 'session-1');
    });

    it('does not require confirmation for CancelOrder at LOW default risk', async () => {
      const action = makeCancelOrder();
      const result = await gate.enforce(action, 'user-1', 'session-1');

      expect(result.required).toBe(false);
      expect(mockFlow.createChallenge).not.toHaveBeenCalled();
    });

    it('does not require confirmation for NoAction', async () => {
      const action = makeNoAction();
      const result = await gate.enforce(action, 'user-1', 'session-1');

      expect(result.required).toBe(false);
    });

    it('passes correct arguments to approvalFlow.createChallenge', async () => {
      const challenge = makeChallenge();
      mockFlow.createChallenge.mockResolvedValue(challenge);

      const action = makePlaceOrder({ quantity: 10, price: 60000 });
      await gate.enforce(action, 'user-42', 'sess-99');

      expect(mockFlow.createChallenge).toHaveBeenCalledWith(action, 'user-42', 'sess-99');
    });
  });
});
