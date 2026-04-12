import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SecurityConfig } from '../types/config.js';
import { SecurityEventType, RiskLevel } from '../types/events.js';
import { SessionError, SecurityErrorCode } from '../types/errors.js';
import type { ValidatedToken } from './jwt.validator.js';

// ─── Interfaces ─────────────────────────────────────────────────────────────

export interface RedisAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  setex(key: string, ttlSeconds: number, value: string): Promise<void>;
  del(key: string): Promise<void>;
}

export interface AlertBus {
  emit(alert: {
    level: string;
    type: string;
    message: string;
    correlationId: string;
    metadata: Record<string, unknown>;
  }): void;
}

export interface SessionAuditLogger {
  log(event: {
    eventType: SecurityEventType;
    timestamp: string;
    correlationId: string;
    riskLevel: RiskLevel;
    payload: Record<string, unknown>;
  }): void;
}

// ─── Schemas ────────────────────────────────────────────────────────────────

export const IncomingRequestSchema = z.object({
  ip: z.string().min(1),
  userAgent: z.string().min(1),
  tlsFingerprint: z.string().min(1),
});

export type IncomingRequest = z.infer<typeof IncomingRequestSchema>;

export const BoundSessionSchema = z.object({
  sessionId: z.string().min(1),
  userId: z.string().min(1),
  fingerprint: z.string().min(1),
  boundAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

export type BoundSession = z.infer<typeof BoundSessionSchema>;

// ─── SessionBinder ──────────────────────────────────────────────────────────

const SESSION_PREFIX = 'session:bind:';

export class SessionBinder {
  private readonly logger: SessionAuditLogger;
  private readonly alertBus: AlertBus;
  private readonly redis: RedisAdapter;

  constructor(
    _config: SecurityConfig,
    logger: SessionAuditLogger,
    alertBus: AlertBus,
    redis: RedisAdapter,
  ) {
    this.logger = logger;
    this.alertBus = alertBus;
    this.redis = redis;
  }

  private computeFingerprint(
    ip: string,
    userAgent: string,
    tlsFingerprint: string,
    sessionId: string,
  ): string {
    const data = `${ip}|${userAgent}|${tlsFingerprint}|${sessionId}`;
    return createHash('sha256').update(data).digest('hex');
  }

  public async bind(
    token: ValidatedToken,
    request: IncomingRequest,
  ): Promise<BoundSession> {
    const validated = IncomingRequestSchema.parse(request);
    const fingerprint = this.computeFingerprint(
      validated.ip,
      validated.userAgent,
      validated.tlsFingerprint,
      token.sessionId,
    );

    const ttlSeconds = token.expiresAt - Math.floor(Date.now() / 1000);
    const effectiveTtl = Math.max(ttlSeconds, 60);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + effectiveTtl * 1000);

    const session: BoundSession = {
      sessionId: token.sessionId,
      userId: token.userId,
      fingerprint,
      boundAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };

    const redisKey = `${SESSION_PREFIX}${token.sessionId}`;
    await this.redis.setex(redisKey, effectiveTtl, JSON.stringify(session));

    return session;
  }

  public async verify(
    sessionId: string,
    request: IncomingRequest,
  ): Promise<BoundSession> {
    const correlationId = randomUUID();
    const validated = IncomingRequestSchema.parse(request);
    const redisKey = `${SESSION_PREFIX}${sessionId}`;
    const stored = await this.redis.get(redisKey);

    if (stored === null) {
      throw new SessionError(
        'Session not found',
        correlationId,
        SecurityErrorCode.SESSION_NOT_FOUND,
        { sessionId },
      );
    }

    const parsed: unknown = JSON.parse(stored);
    const session = BoundSessionSchema.parse(parsed);

    const computedFingerprint = this.computeFingerprint(
      validated.ip,
      validated.userAgent,
      validated.tlsFingerprint,
      sessionId,
    );

    if (computedFingerprint !== session.fingerprint) {
      this.logger.log({
        eventType: SecurityEventType.SESSION_MISMATCH,
        timestamp: new Date().toISOString(),
        correlationId,
        riskLevel: RiskLevel.CRITICAL,
        payload: {
          userId: session.userId,
          expectedSessionId: session.sessionId,
          actualSessionId: sessionId,
          ip: validated.ip,
        },
      });

      this.alertBus.emit({
        level: 'CRITICAL',
        type: 'SESSION_MISMATCH',
        message: `Session fingerprint mismatch for user ${session.userId} on session ${sessionId}`,
        correlationId,
        metadata: {
          userId: session.userId,
          sessionId,
          ip: validated.ip,
        },
      });

      throw new SessionError(
        'Session fingerprint mismatch — possible session hijack',
        correlationId,
        SecurityErrorCode.SESSION_HIJACK_DETECTED,
        { sessionId, userId: session.userId, ip: validated.ip },
      );
    }

    return session;
  }

  public async destroy(sessionId: string): Promise<void> {
    const redisKey = `${SESSION_PREFIX}${sessionId}`;
    await this.redis.del(redisKey);
  }
}
