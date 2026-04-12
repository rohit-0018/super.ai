import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContextIntegrityService, type RedisAdapter, type Logger, type EventEmitter } from './context.integrity.js';
import { IntegrityError } from '../types/errors.js';
import { SecurityEventType } from '../types/events.js';

describe('ContextIntegrityService', () => {
  const SECRET = 'a]3kf9#mLp2$xQw7!Zr5^Yv8&Tn0@Cd6';
  const SYSTEM_PROMPT = 'You are a helpful trading assistant.';
  const SESSION_ID = 'session-abc-123';

  let redis: RedisAdapter;
  let logger: Logger;
  let emitter: EventEmitter;
  let service: ContextIntegrityService;

  beforeEach(() => {
    const store = new Map<string, string>();
    redis = {
      get: vi.fn(async (key: string): Promise<string | null> => store.get(key) ?? null),
      set: vi.fn(async (key: string, value: string): Promise<void> => {
        store.set(key, value);
      }),
    };
    logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    emitter = {
      emit: vi.fn(),
    };
    service = new ContextIntegrityService(
      { hmacChainSecret: SECRET },
      logger,
      redis,
      emitter,
    );
  });

  describe('seal', () => {
    it('should return a SealedContext with hash, signature, sessionId, and timestamp', async () => {
      const sealed = await service.seal(SYSTEM_PROMPT, SESSION_ID);
      expect(sealed.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(sealed.signature).toMatch(/^[a-f0-9]{64}$/);
      expect(sealed.sessionId).toBe(SESSION_ID);
      expect(sealed.timestamp).toBeDefined();
    });

    it('should store the sealed context in Redis', async () => {
      await service.seal(SYSTEM_PROMPT, SESSION_ID);
      expect(redis.set).toHaveBeenCalledWith(
        `security:context:${SESSION_ID}`,
        expect.any(String),
        3600,
      );
    });

    it('should log the sealing', async () => {
      await service.seal(SYSTEM_PROMPT, SESSION_ID);
      expect(logger.info).toHaveBeenCalledWith('Context sealed', expect.objectContaining({ sessionId: SESSION_ID }));
    });
  });

  describe('verify', () => {
    it('should verify successfully with matching prompt', async () => {
      await service.seal(SYSTEM_PROMPT, SESSION_ID);
      const result = await service.verify(SYSTEM_PROMPT, SESSION_ID);
      expect(result.sessionId).toBe(SESSION_ID);
      expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should throw IntegrityError when no sealed context exists', async () => {
      await expect(service.verify(SYSTEM_PROMPT, 'nonexistent-session')).rejects.toThrow(IntegrityError);
    });

    it('should throw IntegrityError when system prompt was tampered', async () => {
      await service.seal(SYSTEM_PROMPT, SESSION_ID);
      await expect(service.verify('TAMPERED PROMPT', SESSION_ID)).rejects.toThrow(IntegrityError);
    });

    it('should emit CONTEXT_INTEGRITY_FAILURE on mismatch', async () => {
      await service.seal(SYSTEM_PROMPT, SESSION_ID);
      try {
        await service.verify('TAMPERED PROMPT', SESSION_ID);
      } catch {
        // expected
      }
      expect(emitter.emit).toHaveBeenCalledWith(
        SecurityEventType.CONTEXT_INTEGRITY_FAILURE,
        expect.objectContaining({
          strategyId: SESSION_ID,
          field: 'systemPrompt',
        }),
      );
    });

    it('should emit ALERT_EMITTED on mismatch', async () => {
      await service.seal(SYSTEM_PROMPT, SESSION_ID);
      try {
        await service.verify('TAMPERED PROMPT', SESSION_ID);
      } catch {
        // expected
      }
      expect(emitter.emit).toHaveBeenCalledWith(
        SecurityEventType.ALERT_EMITTED,
        expect.objectContaining({
          alertType: 'CONTEXT_INTEGRITY_FAILURE',
        }),
      );
    });

    it('should log error on integrity failure', async () => {
      await service.seal(SYSTEM_PROMPT, SESSION_ID);
      try {
        await service.verify('TAMPERED PROMPT', SESSION_ID);
      } catch {
        // expected
      }
      expect(logger.error).toHaveBeenCalledWith(
        'Context integrity failure',
        expect.objectContaining({ sessionId: SESSION_ID }),
      );
    });
  });

  describe('different secrets produce different signatures', () => {
    it('should produce different hashes with different secrets', async () => {
      const service2 = new ContextIntegrityService(
        { hmacChainSecret: 'B]3kf9#mLp2$xQw7!Zr5^Yv8&Tn0@Cd6' },
        logger,
        redis,
      );

      const sealed1 = await service.seal(SYSTEM_PROMPT, SESSION_ID);
      // Use a different session to avoid key collision
      const sealed2 = await service2.seal(SYSTEM_PROMPT, 'session-other');
      // Same hash (SHA-256 of prompt+session is independent of secret) but different signature
      expect(sealed1.signature).not.toBe(sealed2.signature);
    });
  });
});
