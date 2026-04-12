import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KillSwitch } from './kill.switch.js';
import type { KillSwitchScope } from './kill.switch.js';
import type { RedisAdapter, Logger, AlertBus } from './circuit.breaker.js';
import type { SecurityConfig } from '../types/config.js';
import { SecurityEventType, RiskLevel } from '../types/events.js';

// ─── Mock factories ─────────────────────────────────────────────────────────

function createMockRedis(): RedisAdapter {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
    }),
    del: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    incr: vi.fn(async () => 1),
    expire: vi.fn(async () => undefined),
    ttl: vi.fn(async () => -1),
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
  return { emit: vi.fn() };
}

function createMockConfig(overrides?: Partial<SecurityConfig>): SecurityConfig {
  return {
    adminUserId: 'admin-001',
    sessionDrawdownKillSwitchPercent: 10,
    ...overrides,
  } as SecurityConfig;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('KillSwitch', () => {
  let redis: RedisAdapter;
  let logger: Logger;
  let alertBus: AlertBus;
  let config: SecurityConfig;

  beforeEach(() => {
    redis = createMockRedis();
    logger = createMockLogger();
    alertBus = createMockAlertBus();
    config = createMockConfig();
  });

  function createKillSwitch(): KillSwitch {
    return new KillSwitch(config, logger, alertBus, redis);
  }

  describe('trigger', () => {
    it('should persist active state for GLOBAL scope', async () => {
      const ks = createKillSwitch();
      await ks.trigger({ type: 'GLOBAL' }, 'emergency', 'system');
      expect(await ks.isActive({ type: 'GLOBAL' })).toBe(true);
    });

    it('should persist active state for USER scope', async () => {
      const ks = createKillSwitch();
      const scope: KillSwitchScope = { type: 'USER', userId: 'user-1' };
      await ks.trigger(scope, 'loss limit', 'risk-engine');
      expect(await ks.isActive(scope)).toBe(true);
    });

    it('should persist active state for STRATEGY scope', async () => {
      const ks = createKillSwitch();
      const scope: KillSwitchScope = { type: 'STRATEGY', strategyId: 'strat-1' };
      await ks.trigger(scope, 'drift detected', 'monitor');
      expect(await ks.isActive(scope)).toBe(true);
    });

    it('should emit KILL_SWITCH_TRIGGERED alert', async () => {
      const ks = createKillSwitch();
      await ks.trigger({ type: 'GLOBAL' }, 'test', 'tester');
      expect(alertBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: SecurityEventType.KILL_SWITCH_TRIGGERED,
          level: RiskLevel.CRITICAL,
        }),
      );
    });

    it('should log an error when triggered', async () => {
      const ks = createKillSwitch();
      await ks.trigger({ type: 'GLOBAL' }, 'test reason', 'admin');
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Kill switch triggered'),
        expect.objectContaining({ reason: 'test reason' }),
      );
    });
  });

  describe('isActive', () => {
    it('should return false when no kill switch has been triggered', async () => {
      const ks = createKillSwitch();
      expect(await ks.isActive({ type: 'GLOBAL' })).toBe(false);
      expect(await ks.isActive({ type: 'USER', userId: 'u1' })).toBe(false);
      expect(await ks.isActive({ type: 'STRATEGY', strategyId: 's1' })).toBe(false);
    });

    it('should return true for user scope if GLOBAL is active', async () => {
      const ks = createKillSwitch();
      await ks.trigger({ type: 'GLOBAL' }, 'halt all', 'admin');
      expect(await ks.isActive({ type: 'USER', userId: 'any-user' })).toBe(true);
    });

    it('should return true for strategy scope if GLOBAL is active', async () => {
      const ks = createKillSwitch();
      await ks.trigger({ type: 'GLOBAL' }, 'halt all', 'admin');
      expect(await ks.isActive({ type: 'STRATEGY', strategyId: 'any' })).toBe(true);
    });

    it('should not return true for other users if only one user is killed', async () => {
      const ks = createKillSwitch();
      await ks.trigger({ type: 'USER', userId: 'u1' }, 'loss', 'system');
      expect(await ks.isActive({ type: 'USER', userId: 'u1' })).toBe(true);
      expect(await ks.isActive({ type: 'USER', userId: 'u2' })).toBe(false);
    });
  });

  describe('reset', () => {
    it('should deactivate the kill switch when reset by admin', async () => {
      const ks = createKillSwitch();
      await ks.trigger({ type: 'GLOBAL' }, 'test', 'system');
      expect(await ks.isActive({ type: 'GLOBAL' })).toBe(true);

      await ks.reset({ type: 'GLOBAL' }, 'admin-001');
      expect(await ks.isActive({ type: 'GLOBAL' })).toBe(false);
    });

    it('should throw if non-admin tries to reset', async () => {
      const ks = createKillSwitch();
      await ks.trigger({ type: 'GLOBAL' }, 'test', 'system');

      await expect(
        ks.reset({ type: 'GLOBAL' }, 'random-user'),
      ).rejects.toThrow('Unauthorized kill switch reset attempt');
    });

    it('should emit KILL_SWITCH_RESET alert', async () => {
      const ks = createKillSwitch();
      await ks.trigger({ type: 'GLOBAL' }, 'test', 'system');
      await ks.reset({ type: 'GLOBAL' }, 'admin-001');

      expect(alertBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: SecurityEventType.KILL_SWITCH_RESET,
        }),
      );
    });

    it('should only reset the specified scope', async () => {
      const ks = createKillSwitch();
      await ks.trigger({ type: 'GLOBAL' }, 'g', 'system');
      await ks.trigger({ type: 'USER', userId: 'u1' }, 'u', 'system');

      await ks.reset({ type: 'USER', userId: 'u1' }, 'admin-001');
      expect(await ks.isActive({ type: 'USER', userId: 'u1' })).toBe(true); // still true because GLOBAL is active
      expect(await ks.isActive({ type: 'GLOBAL' })).toBe(true);

      await ks.reset({ type: 'GLOBAL' }, 'admin-001');
      expect(await ks.isActive({ type: 'USER', userId: 'u1' })).toBe(false);
      expect(await ks.isActive({ type: 'GLOBAL' })).toBe(false);
    });
  });

  describe('middleware', () => {
    function createMockReq(headers: Record<string, string> = {}): {
      headers: Record<string, string | string[] | undefined>;
    } {
      return { headers };
    }

    function createMockRes(): {
      status: ReturnType<typeof vi.fn>;
      json: ReturnType<typeof vi.fn>;
    } {
      const res = {
        status: vi.fn(),
        json: vi.fn(),
      };
      res.status.mockReturnValue(res);
      return res;
    }

    it('should call next() when no kill switch is active', async () => {
      const ks = createKillSwitch();
      const mw = ks.middleware();
      const next = vi.fn();
      const req = createMockReq();
      const res = createMockRes();

      await mw(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should return 503 when global kill switch is active', async () => {
      const ks = createKillSwitch();
      await ks.trigger({ type: 'GLOBAL' }, 'halt', 'admin');

      const mw = ks.middleware();
      const next = vi.fn();
      const req = createMockReq();
      const res = createMockRes();

      await mw(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'KILL_SWITCH_ACTIVE' }),
      );
    });

    it('should return 503 when user kill switch is active', async () => {
      const ks = createKillSwitch();
      await ks.trigger({ type: 'USER', userId: 'u1' }, 'loss', 'system');

      const mw = ks.middleware();
      const next = vi.fn();
      const req = createMockReq({ 'x-user-id': 'u1' });
      const res = createMockRes();

      await mw(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
    });

    it('should return 503 when strategy kill switch is active', async () => {
      const ks = createKillSwitch();
      await ks.trigger({ type: 'STRATEGY', strategyId: 's1' }, 'drift', 'monitor');

      const mw = ks.middleware();
      const next = vi.fn();
      const req = createMockReq({ 'x-strategy-id': 's1' });
      const res = createMockRes();

      await mw(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
    });

    it('should allow request when a different user kill switch is active', async () => {
      const ks = createKillSwitch();
      await ks.trigger({ type: 'USER', userId: 'u1' }, 'loss', 'system');

      const mw = ks.middleware();
      const next = vi.fn();
      const req = createMockReq({ 'x-user-id': 'u2' });
      const res = createMockRes();

      await mw(req, res, next);
      expect(next).toHaveBeenCalled();
    });
  });
});
