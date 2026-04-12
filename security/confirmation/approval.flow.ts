import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AgentAction } from '../types/actions.js';
import type { SecurityConfig } from '../types/config.js';
import { RiskLevel } from '../types/events.js';
import { SecurityError, SecurityErrorCode } from '../types/errors.js';

// ─── Dependency interfaces ──────────────────────────────────────────────────

export interface RedisAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

// ─── Domain types ───────────────────────────────────────────────────────────

export interface ApprovalChallenge {
  readonly challengeId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly actionPayload: string;
  readonly signature: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ApprovedAction {
  readonly challengeId: string;
  readonly userId: string;
  readonly action: AgentAction;
  readonly approvedAt: string;
}

// ─── Error subclasses ───────────────────────────────────────────────────────

export class ConfirmationExpiredError extends SecurityError {
  constructor(challengeId: string, correlationId: string) {
    super(
      `Confirmation challenge expired: ${challengeId}`,
      SecurityErrorCode.ACTION_CONFIRMATION_EXPIRED,
      RiskLevel.MEDIUM,
      correlationId,
      { challengeId },
    );
    this.name = 'ConfirmationExpiredError';
  }
}

export class ConfirmationReplayError extends SecurityError {
  constructor(challengeId: string, correlationId: string) {
    super(
      `Confirmation challenge already consumed: ${challengeId}`,
      SecurityErrorCode.ACTION_CONFIRMATION_REQUIRED,
      RiskLevel.HIGH,
      correlationId,
      { challengeId },
    );
    this.name = 'ConfirmationReplayError';
  }
}

export class ConfirmationOwnershipError extends SecurityError {
  constructor(challengeId: string, correlationId: string) {
    super(
      `User does not own confirmation challenge: ${challengeId}`,
      SecurityErrorCode.AUTHZ_RESOURCE_FORBIDDEN,
      RiskLevel.HIGH,
      correlationId,
      { challengeId },
    );
    this.name = 'ConfirmationOwnershipError';
  }
}

export class ConfirmationSignatureError extends SecurityError {
  constructor(challengeId: string, correlationId: string) {
    super(
      `Invalid approval signature for challenge: ${challengeId}`,
      SecurityErrorCode.INTEGRITY_SIGNATURE_INVALID,
      RiskLevel.HIGH,
      correlationId,
      { challengeId },
    );
    this.name = 'ConfirmationSignatureError';
  }
}

// ─── Redis key helpers ──────────────────────────────────────────────────────

const CHALLENGE_PREFIX = 'confirmation:challenge:';
const CONSUMED_PREFIX = 'confirmation:consumed:';

function challengeKey(challengeId: string): string {
  return `${CHALLENGE_PREFIX}${challengeId}`;
}

function consumedKey(challengeId: string): string {
  return `${CONSUMED_PREFIX}${challengeId}`;
}

// ─── Default TTL ────────────────────────────────────────────────────────────

const DEFAULT_CHALLENGE_TTL_SECONDS = 300;
const CONSUMED_MARKER_TTL_SECONDS = 3600;

// ─── ApprovalFlow ───────────────────────────────────────────────────────────

export class ApprovalFlow {
  private readonly config: SecurityConfig;
  private readonly logger: Logger;
  private readonly redis: RedisAdapter;

  constructor(config: SecurityConfig, logger: Logger, redisAdapter: RedisAdapter) {
    this.config = config;
    this.logger = logger;
    this.redis = redisAdapter;
  }

  async createChallenge(
    action: AgentAction,
    userId: string,
    sessionId: string,
  ): Promise<ApprovalChallenge> {
    const challengeId = randomUUID();
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(
      Date.now() + DEFAULT_CHALLENGE_TTL_SECONDS * 1000,
    ).toISOString();
    const actionPayload = JSON.stringify(action);
    const signature = this.computeHmac(challengeId, userId, sessionId, actionPayload);

    const challenge: ApprovalChallenge = {
      challengeId,
      userId,
      sessionId,
      actionPayload,
      signature,
      createdAt,
      expiresAt,
    };

    await this.redis.set(
      challengeKey(challengeId),
      JSON.stringify(challenge),
      DEFAULT_CHALLENGE_TTL_SECONDS,
    );

    this.logger.info('Approval challenge created', {
      challengeId,
      userId,
      sessionId,
      actionType: action.type,
    });

    return challenge;
  }

  async submitApproval(
    challengeId: string,
    userId: string,
    signedApproval: string,
  ): Promise<ApprovedAction> {
    const correlationId = randomUUID();

    // Check replay (consumed marker)
    const consumedMarker = await this.redis.get(consumedKey(challengeId));
    if (consumedMarker !== null) {
      this.logger.warn('Replay attempt on consumed challenge', { challengeId, userId });
      throw new ConfirmationReplayError(challengeId, correlationId);
    }

    // Retrieve challenge
    const raw = await this.redis.get(challengeKey(challengeId));
    if (raw === null) {
      this.logger.warn('Challenge not found or expired', { challengeId, userId });
      throw new ConfirmationExpiredError(challengeId, correlationId);
    }

    const challenge: ApprovalChallenge = JSON.parse(raw) as ApprovalChallenge;

    // Check expiry
    if (new Date(challenge.expiresAt).getTime() < Date.now()) {
      await this.redis.del(challengeKey(challengeId));
      this.logger.warn('Challenge expired at submission time', { challengeId, userId });
      throw new ConfirmationExpiredError(challengeId, correlationId);
    }

    // Check ownership
    if (challenge.userId !== userId) {
      this.logger.warn('Ownership mismatch on challenge', {
        challengeId,
        expectedUserId: challenge.userId,
        actualUserId: userId,
      });
      throw new ConfirmationOwnershipError(challengeId, correlationId);
    }

    // Verify approval signature
    const expectedSignature = this.computeApprovalSignature(challengeId, userId);
    if (!this.safeCompare(signedApproval, expectedSignature)) {
      this.logger.warn('Invalid approval signature', { challengeId, userId });
      throw new ConfirmationSignatureError(challengeId, correlationId);
    }

    // Mark consumed (delete challenge, set consumed marker)
    await this.redis.del(challengeKey(challengeId));
    await this.redis.set(consumedKey(challengeId), 'consumed', CONSUMED_MARKER_TTL_SECONDS);

    const action: AgentAction = JSON.parse(challenge.actionPayload) as AgentAction;
    const approvedAt = new Date().toISOString();

    this.logger.info('Approval challenge approved', {
      challengeId,
      userId,
      actionType: action.type,
    });

    return {
      challengeId,
      userId,
      action,
      approvedAt,
    };
  }

  // ── Internal helpers ────────────────────────────────────────────────────

  private computeHmac(
    challengeId: string,
    userId: string,
    sessionId: string,
    actionPayload: string,
  ): string {
    const data = `${challengeId}:${userId}:${sessionId}:${actionPayload}`;
    return createHmac('sha256', this.config.hmacChainSecret)
      .update(data)
      .digest('hex');
  }

  private computeApprovalSignature(challengeId: string, userId: string): string {
    const data = `approve:${challengeId}:${userId}`;
    return createHmac('sha256', this.config.hmacChainSecret)
      .update(data)
      .digest('hex');
  }

  private safeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) {
      return false;
    }
    return timingSafeEqual(Buffer.from(a, 'utf-8'), Buffer.from(b, 'utf-8'));
  }
}
