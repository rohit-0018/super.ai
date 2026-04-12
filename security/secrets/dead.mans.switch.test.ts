import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DeadMansSwitch } from './dead.mans.switch.js';
import type {
  DeadMansSwitchConfig,
  Logger,
  KillSwitchInterface,
  RedisAdapter,
  AlertBus,
} from './dead.mans.switch.js';
import { SecurityEventType, RiskLevel } from '../types/events.js';

// ─── Mock factories ─────────────────────────────────────────────────────────

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createMockKillSwitch(): KillSwitchInterface {
  return {
    trigger: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockRedisAdapter(): RedisAdapter {
  return {
    get: vi.fn(),
    set: vi.fn().mockResolvedValue(undefined),
    setex: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockAlertBus(): AlertBus {
  return {
    emit: vi.fn(),
  };
}

function createConfig(overrides: Partial<DeadMansSwitchConfig> = {}): DeadMansSwitchConfig {
  return {
    deadManSwitchHeartbeatTimeoutSeconds: 120,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('DeadMansSwitch', () => {
  let config: DeadMansSwitchConfig;
  let logger: ReturnType<typeof createMockLogger>;
  let killSwitch: ReturnType<typeof createMockKillSwitch>;
  let redisAdapter: ReturnType<typeof createMockRedisAdapter>;
  let alertBus: ReturnType<typeof createMockAlertBus>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    config = createConfig();
    logger = createMockLogger();
    killSwitch = createMockKillSwitch();
    redisAdapter = createMockRedisAdapter();
    alertBus = createMockAlertBus();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('recordHeartbeat', () => {
    it('should write timestamp to Redis with 2x TTL', async () => {
      const dms = new DeadMansSwitch(config, logger, killSwitch, redisAdapter, alertBus);

      await dms.recordHeartbeat();

      expect(redisAdapter.setex).toHaveBeenCalledTimes(1);
      const [key, ttl, value] = vi.mocked(redisAdapter.setex).mock.calls[0]!;
      expect(key).toBe('deadman:heartbeat');
      expect(ttl).toBe(240); // 120 * 2
      expect(typeof value).toBe('string');
      // Value should be a valid ISO timestamp
      expect(() => new Date(value).toISOString()).not.toThrow();
    });

    it('should log the heartbeat', async () => {
      const dms = new DeadMansSwitch(config, logger, killSwitch, redisAdapter, alertBus);

      await dms.recordHeartbeat();

      expect(logger.info).toHaveBeenCalledWith(
        'Dead man switch heartbeat recorded',
        expect.objectContaining({
          ttlSeconds: 240,
        }),
      );
    });
  });

  describe('start', () => {
    it('should set up an interval at half the timeout', () => {
      const setIntervalSpy = vi.spyOn(global, 'setInterval');

      const dms = new DeadMansSwitch(config, logger, killSwitch, redisAdapter, alertBus);
      dms.start();

      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(setIntervalSpy).toHaveBeenCalledWith(
        expect.any(Function),
        60_000, // 120 / 2 * 1000
      );

      dms.stop();
    });

    it('should warn if already started', () => {
      const dms = new DeadMansSwitch(config, logger, killSwitch, redisAdapter, alertBus);
      dms.start();
      dms.start();

      expect(logger.warn).toHaveBeenCalledWith('DeadMansSwitch already started');

      dms.stop();
    });

    it('should log start info', () => {
      const dms = new DeadMansSwitch(config, logger, killSwitch, redisAdapter, alertBus);
      dms.start();

      expect(logger.info).toHaveBeenCalledWith(
        'Starting dead man switch',
        expect.objectContaining({
          timeoutSeconds: 120,
          checkIntervalMs: 60_000,
        }),
      );

      dms.stop();
    });
  });

  describe('stop', () => {
    it('should clear the interval', () => {
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      const dms = new DeadMansSwitch(config, logger, killSwitch, redisAdapter, alertBus);
      dms.start();
      dms.stop();

      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith('Dead man switch stopped');
    });

    it('should be safe to call when not started', () => {
      const dms = new DeadMansSwitch(config, logger, killSwitch, redisAdapter, alertBus);
      dms.stop(); // Should not throw

      expect(logger.info).not.toHaveBeenCalledWith('Dead man switch stopped');
    });
  });

  describe('heartbeat check', () => {
    it('should trigger kill switch when heartbeat key is expired (null)', async () => {
      vi.mocked(redisAdapter.get).mockResolvedValue(null);

      const dms = new DeadMansSwitch(config, logger, killSwitch, redisAdapter, alertBus);
      dms.start();

      // Advance timer to trigger the check
      await vi.advanceTimersByTimeAsync(60_000);

      expect(redisAdapter.get).toHaveBeenCalledWith('deadman:heartbeat');
      expect(killSwitch.trigger).toHaveBeenCalledTimes(1);
      expect(killSwitch.trigger).toHaveBeenCalledWith(
        { type: 'GLOBAL' },
        expect.stringContaining('DEAD_MANS_SWITCH_TRIGGERED'),
        'DeadMansSwitch',
      );
    });

    it('should emit CRITICAL event when triggered', async () => {
      vi.mocked(redisAdapter.get).mockResolvedValue(null);

      const dms = new DeadMansSwitch(config, logger, killSwitch, redisAdapter, alertBus);
      dms.start();

      await vi.advanceTimersByTimeAsync(60_000);

      expect(alertBus.emit).toHaveBeenCalledTimes(1);
      const emitCall = vi.mocked(alertBus.emit).mock.calls[0]?.[0];
      expect(emitCall?.level).toBe(RiskLevel.CRITICAL);
      expect(emitCall?.type).toBe(SecurityEventType.DEAD_MANS_SWITCH_TRIGGERED);
    });

    it('should stop the interval after triggering', async () => {
      vi.mocked(redisAdapter.get).mockResolvedValue(null);
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      const dms = new DeadMansSwitch(config, logger, killSwitch, redisAdapter, alertBus);
      dms.start();

      await vi.advanceTimersByTimeAsync(60_000);

      expect(clearIntervalSpy).toHaveBeenCalled();
    });

    it('should NOT trigger when heartbeat key exists', async () => {
      vi.mocked(redisAdapter.get).mockResolvedValue(new Date().toISOString());

      const dms = new DeadMansSwitch(config, logger, killSwitch, redisAdapter, alertBus);
      dms.start();

      await vi.advanceTimersByTimeAsync(60_000);

      expect(killSwitch.trigger).not.toHaveBeenCalled();
      expect(alertBus.emit).not.toHaveBeenCalled();

      dms.stop();
    });

    it('should log error if Redis check fails', async () => {
      vi.mocked(redisAdapter.get).mockRejectedValue(new Error('Redis connection lost'));

      const dms = new DeadMansSwitch(config, logger, killSwitch, redisAdapter, alertBus);
      dms.start();

      await vi.advanceTimersByTimeAsync(60_000);

      expect(logger.error).toHaveBeenCalledWith(
        'Error checking dead man switch heartbeat',
        expect.objectContaining({ error: 'Redis connection lost' }),
      );
      expect(killSwitch.trigger).not.toHaveBeenCalled();

      dms.stop();
    });

    it('should include elapsed seconds in trigger metadata', async () => {
      // Record a heartbeat, then advance time past expiry
      vi.mocked(redisAdapter.get).mockResolvedValue(null);

      const dms = new DeadMansSwitch(config, logger, killSwitch, redisAdapter, alertBus);

      // Record heartbeat at t=0
      await dms.recordHeartbeat();

      dms.start();

      // Advance past the check interval
      vi.setSystemTime(new Date(Date.now() + 130_000)); // 130 seconds later
      await vi.advanceTimersByTimeAsync(60_000);

      const emitCall = vi.mocked(alertBus.emit).mock.calls[0]?.[0];
      expect(emitCall?.metadata).toEqual(
        expect.objectContaining({
          timeoutSeconds: 120,
        }),
      );
      expect(typeof emitCall?.metadata?.elapsedSeconds).toBe('number');
    });

    it('should use timeout as elapsed when no previous heartbeat recorded', async () => {
      vi.mocked(redisAdapter.get).mockResolvedValue(null);

      const dms = new DeadMansSwitch(config, logger, killSwitch, redisAdapter, alertBus);
      dms.start();

      await vi.advanceTimersByTimeAsync(60_000);

      const emitCall = vi.mocked(alertBus.emit).mock.calls[0]?.[0];
      expect(emitCall?.metadata?.elapsedSeconds).toBe(120);
      expect(emitCall?.metadata?.lastHeartbeatAt).toBe('never');
    });
  });
});
