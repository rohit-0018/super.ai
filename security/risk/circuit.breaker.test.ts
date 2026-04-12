import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CircuitBreaker } from './circuit.breaker.js';
import type { RedisAdapter, Logger, AlertBus } from './circuit.breaker.js';
import { CircuitBreakerState } from '../types/risk.js';
import { SecurityEventType } from '../types/events.js';

// ─── Mock factories ─────────────────────────────────────────────────────────

function createMockRedis(): RedisAdapter {
  const store = new Map<string, { value: string; expiresAt: number | null }>();
  return {
    get: vi.fn(async (key: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
        store.delete(key);
        return null;
      }
      return entry.value;
    }),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, { value, expiresAt: null });
    }),
    setex: vi.fn(async (key: string, ttlSeconds: number, value: string) => {
      store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    }),
    del: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    incr: vi.fn(async (key: string) => {
      const entry = store.get(key);
      if (!entry || (entry.expiresAt !== null && Date.now() > entry.expiresAt)) {
        store.set(key, { value: '1', expiresAt: null });
        return 1;
      }
      const next = Number(entry.value) + 1;
      entry.value = String(next);
      return next;
    }),
    expire: vi.fn(async (key: string, ttlSeconds: number) => {
      const entry = store.get(key);
      if (entry) {
        entry.expiresAt = Date.now() + ttlSeconds * 1000;
      }
    }),
    ttl: vi.fn(async (_key: string) => -1),
  };
}

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createMockAlertBus(): AlertBus {
  return {
    emit: vi.fn(),
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('CircuitBreaker', () => {
  let redis: RedisAdapter;
  let logger: Logger;
  let alertBus: AlertBus;
  const NAME = 'test-breaker';
  const THRESHOLD = 3;
  const WINDOW_MS = 60_000;
  const RESET_TIMEOUT_MS = 30_000;

  beforeEach(() => {
    redis = createMockRedis();
    logger = createMockLogger();
    alertBus = createMockAlertBus();
    vi.restoreAllMocks();
  });

  function createBreaker(overrides?: {
    threshold?: number;
    resetTimeoutMs?: number;
  }): CircuitBreaker {
    return new CircuitBreaker(
      NAME,
      overrides?.threshold ?? THRESHOLD,
      WINDOW_MS,
      overrides?.resetTimeoutMs ?? RESET_TIMEOUT_MS,
      logger,
      alertBus,
      redis,
    );
  }

  describe('initial state', () => {
    it('should default to CLOSED when no state in Redis', async () => {
      const cb = createBreaker();
      const state = await cb.getState();
      expect(state).toBe(CircuitBreakerState.CLOSED);
    });

    it('should report isOpen as false when CLOSED', async () => {
      const cb = createBreaker();
      expect(await cb.isOpen()).toBe(false);
    });
  });

  describe('CLOSED -> OPEN transition', () => {
    it('should stay CLOSED when failures are below threshold', async () => {
      const cb = createBreaker();
      await cb.recordFailure();
      await cb.recordFailure();
      expect(await cb.getState()).toBe(CircuitBreakerState.CLOSED);
      expect(await cb.isOpen()).toBe(false);
    });

    it('should transition to OPEN when failures reach threshold', async () => {
      const cb = createBreaker();
      await cb.recordFailure();
      await cb.recordFailure();
      await cb.recordFailure();
      expect(await cb.getState()).toBe(CircuitBreakerState.OPEN);
      expect(await cb.isOpen()).toBe(true);
    });

    it('should emit CIRCUIT_BREAKER_OPEN alert when opening', async () => {
      const cb = createBreaker();
      for (let i = 0; i < THRESHOLD; i++) {
        await cb.recordFailure();
      }
      expect(alertBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: SecurityEventType.CIRCUIT_BREAKER_OPEN,
        }),
      );
    });

    it('should not increment failures when already OPEN', async () => {
      const cb = createBreaker();
      for (let i = 0; i < THRESHOLD; i++) {
        await cb.recordFailure();
      }
      const incrCallCountBefore = (redis.incr as ReturnType<typeof vi.fn>).mock.calls.length;
      await cb.recordFailure();
      // incr should not have been called again because state is OPEN
      const incrCallCountAfter = (redis.incr as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(incrCallCountAfter).toBe(incrCallCountBefore);
    });
  });

  describe('OPEN -> HALF_OPEN transition', () => {
    it('should transition to HALF_OPEN after resetTimeout elapses', async () => {
      const cb = createBreaker({ resetTimeoutMs: 100 });
      // Force open
      await cb.forceOpen('test');
      expect(await cb.getState()).toBe(CircuitBreakerState.OPEN);

      // Simulate time passing by overwriting the openedAt key
      await redis.set(`cb:${NAME}:openedAt`, String(Date.now() - 200));
      const state = await cb.getState();
      expect(state).toBe(CircuitBreakerState.HALF_OPEN);
    });

    it('should emit CIRCUIT_BREAKER_HALF_OPEN when transitioning', async () => {
      const cb = createBreaker({ resetTimeoutMs: 100 });
      await cb.forceOpen('test');
      await redis.set(`cb:${NAME}:openedAt`, String(Date.now() - 200));
      await cb.getState();
      expect(alertBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: SecurityEventType.CIRCUIT_BREAKER_HALF_OPEN,
        }),
      );
    });

    it('should remain OPEN if resetTimeout has not elapsed', async () => {
      const cb = createBreaker({ resetTimeoutMs: 60_000 });
      await cb.forceOpen('test');
      expect(await cb.getState()).toBe(CircuitBreakerState.OPEN);
    });
  });

  describe('HALF_OPEN -> CLOSED transition', () => {
    it('should transition to CLOSED on success in HALF_OPEN state', async () => {
      const cb = createBreaker({ resetTimeoutMs: 100 });
      await cb.forceOpen('test');
      // Move to HALF_OPEN
      await redis.set(`cb:${NAME}:openedAt`, String(Date.now() - 200));
      await cb.getState(); // triggers HALF_OPEN transition

      await cb.recordSuccess();
      expect(await cb.getState()).toBe(CircuitBreakerState.CLOSED);
    });

    it('should emit CIRCUIT_BREAKER_CLOSED on recovery', async () => {
      const cb = createBreaker({ resetTimeoutMs: 100 });
      await cb.forceOpen('test');
      await redis.set(`cb:${NAME}:openedAt`, String(Date.now() - 200));
      await cb.getState();

      await cb.recordSuccess();
      expect(alertBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: SecurityEventType.CIRCUIT_BREAKER_CLOSED,
        }),
      );
    });
  });

  describe('HALF_OPEN -> OPEN transition', () => {
    it('should transition back to OPEN on failure in HALF_OPEN state', async () => {
      const cb = createBreaker({ resetTimeoutMs: 100 });
      await cb.forceOpen('test');
      await redis.set(`cb:${NAME}:openedAt`, String(Date.now() - 200));
      await cb.getState(); // triggers HALF_OPEN

      await cb.recordFailure();
      expect(await cb.getState()).toBe(CircuitBreakerState.OPEN);
    });

    it('should emit CIRCUIT_BREAKER_OPEN again on HALF_OPEN failure', async () => {
      const cb = createBreaker({ resetTimeoutMs: 100 });
      await cb.forceOpen('test');
      await redis.set(`cb:${NAME}:openedAt`, String(Date.now() - 200));
      await cb.getState();

      // Clear previous calls
      (alertBus.emit as ReturnType<typeof vi.fn>).mockClear();
      await cb.recordFailure();

      expect(alertBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: SecurityEventType.CIRCUIT_BREAKER_OPEN,
        }),
      );
    });
  });

  describe('forceOpen', () => {
    it('should immediately open the breaker regardless of failure count', async () => {
      const cb = createBreaker();
      expect(await cb.getState()).toBe(CircuitBreakerState.CLOSED);
      await cb.forceOpen('emergency shutdown');
      expect(await cb.getState()).toBe(CircuitBreakerState.OPEN);
      expect(await cb.isOpen()).toBe(true);
    });

    it('should emit CIRCUIT_BREAKER_OPEN with force open reason', async () => {
      const cb = createBreaker();
      await cb.forceOpen('manual override');
      expect(alertBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: SecurityEventType.CIRCUIT_BREAKER_OPEN,
          message: expect.stringContaining('manual override'),
        }),
      );
    });

    it('should log a warning when force opened', async () => {
      const cb = createBreaker();
      await cb.forceOpen('test reason');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('OPENED'),
        expect.objectContaining({ breakerName: NAME }),
      );
    });
  });

  describe('recordSuccess in CLOSED state', () => {
    it('should be a no-op in CLOSED state', async () => {
      const cb = createBreaker();
      await cb.recordSuccess();
      expect(await cb.getState()).toBe(CircuitBreakerState.CLOSED);
      expect(alertBus.emit).not.toHaveBeenCalled();
    });
  });
});
