// ─── Context Integrity Service ──────────────────────────────────────────────

import { createHash, createHmac } from 'node:crypto';
import type { SecurityConfig } from '../types/config.js';
import { SecurityEventType } from '../types/events.js';
import { IntegrityError, SecurityErrorCode } from '../types/errors.js';

// ─── Minimal interfaces for dependency injection ────────────────────────────

export interface RedisAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
}

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface EventEmitter {
  emit(event: SecurityEventType, payload: Record<string, unknown>): void;
}

export interface SealedContext {
  readonly hash: string;
  readonly signature: string;
  readonly sessionId: string;
  readonly timestamp: string;
}

export class ContextIntegrityService {
  private readonly config: Pick<SecurityConfig, 'hmacChainSecret'>;
  private readonly logger: Logger;
  private readonly redis: RedisAdapter;
  private readonly emitter: EventEmitter | undefined;

  constructor(
    config: Pick<SecurityConfig, 'hmacChainSecret'>,
    logger: Logger,
    redis: RedisAdapter,
    emitter?: EventEmitter,
  ) {
    this.config = config;
    this.logger = logger;
    this.redis = redis;
    this.emitter = emitter;
  }

  public async seal(systemPrompt: string, sessionId: string): Promise<SealedContext> {
    const timestamp = new Date().toISOString();
    const hash = this.computeHash(systemPrompt, sessionId, timestamp);
    const signature = this.sign(hash);

    const sealed: SealedContext = { hash, signature, sessionId, timestamp };

    await this.redis.set(
      this.redisKey(sessionId),
      JSON.stringify(sealed),
      3600, // 1 hour TTL
    );

    this.logger.info('Context sealed', { sessionId, hash });
    return sealed;
  }

  public async verify(systemPrompt: string, sessionId: string): Promise<SealedContext> {
    const raw = await this.redis.get(this.redisKey(sessionId));

    if (raw === null) {
      throw new IntegrityError(
        `No sealed context found for session ${sessionId}`,
        sessionId,
        SecurityErrorCode.INTEGRITY_CONTEXT_TAMPERED,
        { sessionId },
      );
    }

    const stored: SealedContext = JSON.parse(raw) as SealedContext;
    const recomputedHash = this.computeHash(systemPrompt, sessionId, stored.timestamp);
    const recomputedSignature = this.sign(recomputedHash);

    if (recomputedHash !== stored.hash || recomputedSignature !== stored.signature) {
      this.logger.error('Context integrity failure', {
        sessionId,
        expectedHash: stored.hash,
        actualHash: recomputedHash,
      });

      this.emitter?.emit(SecurityEventType.CONTEXT_INTEGRITY_FAILURE, {
        strategyId: sessionId,
        expectedHash: stored.hash,
        actualHash: recomputedHash,
        field: 'systemPrompt',
      });

      this.emitter?.emit(SecurityEventType.ALERT_EMITTED, {
        alertType: 'CONTEXT_INTEGRITY_FAILURE',
        channel: 'webhook',
        destination: 'security-alerts',
        messagePreview: `Context integrity failure for session ${sessionId}`,
        delivered: true,
      });

      throw new IntegrityError(
        `Context integrity check failed for session ${sessionId}`,
        sessionId,
        SecurityErrorCode.INTEGRITY_CONTEXT_TAMPERED,
        {
          sessionId,
          expectedHash: stored.hash,
          actualHash: recomputedHash,
        },
      );
    }

    this.logger.info('Context integrity verified', { sessionId });
    return stored;
  }

  private computeHash(systemPrompt: string, sessionId: string, timestamp: string): string {
    return createHash('sha256')
      .update(systemPrompt)
      .update(sessionId)
      .update(timestamp)
      .digest('hex');
  }

  private sign(hash: string): string {
    return createHmac('sha256', this.config.hmacChainSecret)
      .update(hash)
      .digest('hex');
  }

  private redisKey(sessionId: string): string {
    return `security:context:${sessionId}`;
  }
}
