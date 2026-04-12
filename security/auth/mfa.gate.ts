import { createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { authenticator } from 'otplib';
import type { AgentAction } from '../types/actions.js';
import { AgentActionType } from '../types/actions.js';
import { RiskLevel, SecurityEventType } from '../types/events.js';
import type { SecurityConfig } from '../types/config.js';
import { AuthenticationError, SecurityErrorCode } from '../types/errors.js';

// ─── Interfaces ─────────────────────────────────────────────────────────────

export interface MfaRedisAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  setex(key: string, ttlSeconds: number, value: string): Promise<void>;
  del(key: string): Promise<void>;
}

export interface MfaAuditLogger {
  log(event: {
    eventType: SecurityEventType;
    timestamp: string;
    correlationId: string;
    riskLevel: RiskLevel;
    payload: Record<string, unknown>;
  }): void;
}

export interface MfaSecretStore {
  getTotpSecret(userId: string): Promise<string>;
}

// ─── Schemas ────────────────────────────────────────────────────────────────

export const MfaChallengeSchema = z.object({
  challengeId: z.string().uuid(),
  userId: z.string().min(1),
  action: z.string().min(1),
  issuedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  signature: z.string().min(1),
});

export type MfaChallenge = z.infer<typeof MfaChallengeSchema>;

// ─── Risk level ordering ────────────────────────────────────────────────────

const RISK_LEVEL_ORDER: Record<RiskLevel, number> = {
  [RiskLevel.LOW]: 0,
  [RiskLevel.MEDIUM]: 1,
  [RiskLevel.HIGH]: 2,
  [RiskLevel.CRITICAL]: 3,
};

// ─── High-risk actions that always require MFA ──────────────────────────────

const HIGH_RISK_ACTION_TYPES: ReadonlySet<AgentActionType> = new Set([
  AgentActionType.PlaceOrder,
  AgentActionType.ClosePosition,
]);

// ─── Constants ──────────────────────────────────────────────────────────────

const MFA_CHALLENGE_PREFIX = 'mfa:challenge:';
const MFA_CHALLENGE_EXPIRY_SECONDS = 90;

// ─── MfaGate ────────────────────────────────────────────────────────────────

export class MfaGate {
  private readonly config: SecurityConfig;
  private readonly logger: MfaAuditLogger;
  private readonly redis: MfaRedisAdapter;
  private readonly secretStore: MfaSecretStore;

  constructor(
    config: SecurityConfig,
    logger: MfaAuditLogger,
    redis: MfaRedisAdapter,
    secretStore: MfaSecretStore,
  ) {
    this.config = config;
    this.logger = logger;
    this.redis = redis;
    this.secretStore = secretStore;
  }

  public isRequired(action: AgentAction, riskLevel: RiskLevel): boolean {
    // Always require MFA for high-risk action types
    if (HIGH_RISK_ACTION_TYPES.has(action.type)) {
      return true;
    }

    // Require MFA when risk level meets or exceeds the configured threshold
    const thresholdOrder = RISK_LEVEL_ORDER[this.config.mfaStepUpThresholdRiskLevel];
    const currentOrder = RISK_LEVEL_ORDER[riskLevel];
    return currentOrder >= thresholdOrder;
  }

  public async generateChallenge(
    userId: string,
    action: string,
  ): Promise<MfaChallenge> {
    const challengeId = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + MFA_CHALLENGE_EXPIRY_SECONDS;

    // Sign the challenge with HMAC-SHA256 using the HMAC chain secret
    const signatureData = `${challengeId}|${userId}|${action}|${now}|${expiresAt}`;
    const signature = createHmac('sha256', this.config.hmacChainSecret)
      .update(signatureData)
      .digest('hex');

    const challenge: MfaChallenge = {
      challengeId,
      userId,
      action,
      issuedAt: now,
      expiresAt,
      signature,
    };

    // Store challenge in Redis with TTL
    const redisKey = `${MFA_CHALLENGE_PREFIX}${challengeId}`;
    await this.redis.setex(
      redisKey,
      MFA_CHALLENGE_EXPIRY_SECONDS,
      JSON.stringify(challenge),
    );

    this.logger.log({
      eventType: SecurityEventType.MFA_REQUIRED,
      timestamp: new Date().toISOString(),
      correlationId: challengeId,
      riskLevel: RiskLevel.MEDIUM,
      payload: {
        userId,
        triggerAction: action,
        riskScore: 0,
      },
    });

    return challenge;
  }

  public async verifyResponse(
    challengeId: string,
    totpCode: string,
    userId: string,
  ): Promise<boolean> {
    const correlationId = randomUUID();
    const redisKey = `${MFA_CHALLENGE_PREFIX}${challengeId}`;

    // Retrieve the challenge from Redis
    const stored = await this.redis.get(redisKey);
    if (stored === null) {
      this.logger.log({
        eventType: SecurityEventType.MFA_FAILURE,
        timestamp: new Date().toISOString(),
        correlationId,
        riskLevel: RiskLevel.HIGH,
        payload: {
          userId,
          method: 'totp' as const,
          attemptCount: 1,
          reason: 'Challenge not found or expired',
        },
      });

      throw new AuthenticationError(
        'MFA challenge not found or expired',
        correlationId,
        SecurityErrorCode.MFA_CODE_EXPIRED,
        { challengeId },
      );
    }

    const parsed: unknown = JSON.parse(stored);
    const challenge = MfaChallengeSchema.parse(parsed);

    // Verify the challenge belongs to this user
    if (challenge.userId !== userId) {
      throw new AuthenticationError(
        'MFA challenge does not belong to this user',
        correlationId,
        SecurityErrorCode.MFA_CODE_INVALID,
        { challengeId, userId },
      );
    }

    // Verify expiry
    const now = Math.floor(Date.now() / 1000);
    if (now > challenge.expiresAt) {
      await this.redis.del(redisKey);

      this.logger.log({
        eventType: SecurityEventType.MFA_FAILURE,
        timestamp: new Date().toISOString(),
        correlationId,
        riskLevel: RiskLevel.HIGH,
        payload: {
          userId,
          method: 'totp' as const,
          attemptCount: 1,
          reason: 'Challenge expired',
        },
      });

      throw new AuthenticationError(
        'MFA challenge has expired',
        correlationId,
        SecurityErrorCode.MFA_CODE_EXPIRED,
        { challengeId },
      );
    }

    // Verify HMAC signature integrity
    const signatureData = `${challenge.challengeId}|${challenge.userId}|${challenge.action}|${challenge.issuedAt}|${challenge.expiresAt}`;
    const expectedSignature = createHmac('sha256', this.config.hmacChainSecret)
      .update(signatureData)
      .digest('hex');

    if (expectedSignature !== challenge.signature) {
      throw new AuthenticationError(
        'MFA challenge signature tampered',
        correlationId,
        SecurityErrorCode.MFA_CODE_INVALID,
        { challengeId },
      );
    }

    // Verify TOTP code
    const secret = await this.secretStore.getTotpSecret(userId);
    const isValid = authenticator.check(totpCode, secret);

    if (!isValid) {
      this.logger.log({
        eventType: SecurityEventType.MFA_FAILURE,
        timestamp: new Date().toISOString(),
        correlationId,
        riskLevel: RiskLevel.HIGH,
        payload: {
          userId,
          method: 'totp' as const,
          attemptCount: 1,
          reason: 'Invalid TOTP code',
        },
      });

      throw new AuthenticationError(
        'Invalid TOTP code',
        correlationId,
        SecurityErrorCode.MFA_CODE_INVALID,
        { challengeId },
      );
    }

    // Mark challenge as consumed by deleting from Redis
    await this.redis.del(redisKey);

    this.logger.log({
      eventType: SecurityEventType.MFA_SUCCESS,
      timestamp: new Date().toISOString(),
      correlationId,
      riskLevel: RiskLevel.LOW,
      payload: {
        userId,
        method: 'totp' as const,
      },
    });

    return true;
  }
}
