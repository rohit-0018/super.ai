import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LossMonitor } from './loss.monitor.js';
import { KillSwitch } from './kill.switch.js';
import type { RedisAdapter, Logger, AlertBus } from './circuit.breaker.js';
import type { SecurityConfig } from '../types/config.js';
import type { PortfolioSnapshot } from '../types/risk.js';
import { SecurityEventType } from '../types/events.js';

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
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function createMockAlertBus(): AlertBus {
  return { emit: vi.fn() };
}

function createConfig(overrides?: Partial<SecurityConfig>): SecurityConfig {
  return {
    adminUserId: 'admin-001',
    sessionDrawdownKillSwitchPercent: 10,
    ...overrides,
  } as SecurityConfig;
}

function makePortfolio(
  totalNotional: number,
  totalUnrealizedPnl: number,
): PortfolioSnapshot {
  return {
    positions: [],
    totalNotional,
    totalUnrealizedPnl,
    drawdownFromHighWatermarkPercent: 0,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('LossMonitor', () => {
  let redis: RedisAdapter;
  let logger: Logger;
  let alertBus: AlertBus;
  let config: SecurityConfig;
  let killSwitch: KillSwitch;
  let killSwitchRedis: RedisAdapter;

  beforeEach(() => {
    redis = createMockRedis();
    logger = createMockLogger();
    alertBus = createMockAlertBus();
    config = createConfig();
    killSwitchRedis = createMockRedis();
    killSwitch = new KillSwitch(config, logger, alertBus, killSwitchRedis);
    vi.spyOn(killSwitch, 'trigger');
  });

  function createMonitor(): LossMonitor {
    return new LossMonitor(config, logger, alertBus, killSwitch, redis);
  }

  describe('update - high watermark tracking', () => {
    it('should set initial high watermark from first portfolio value', async () => {
      const monitor = createMonitor();
      const portfolio = makePortfolio(100_000, 0); // current value = 100_000
      await monitor.update(portfolio, 'u1', 's1');

      // The HWM should now be stored
      const drawdown = await monitor.getDrawdown('u1');
      expect(drawdown).toBe(0);
    });

    it('should update high watermark when value increases', async () => {
      const monitor = createMonitor();

      // Initial value: 100k
      await monitor.update(makePortfolio(100_000, 0), 'u1', 's1');
      // Value increases to 120k
      await monitor.update(makePortfolio(110_000, 10_000), 'u1', 's1');

      const drawdown = await monitor.getDrawdown('u1');
      expect(drawdown).toBe(0);
    });

    it('should compute drawdown when value decreases', async () => {
      const monitor = createMonitor();

      // Set high watermark at 100k
      await monitor.update(makePortfolio(100_000, 0), 'u1', 's1');
      // Value drops to 95k (5% drawdown)
      await monitor.update(makePortfolio(90_000, 5_000), 'u1', 's1');

      const drawdown = await monitor.getDrawdown('u1');
      expect(drawdown).toBe(5);
    });
  });

  describe('update - kill switch trigger', () => {
    it('should trigger kill switch when drawdown exceeds threshold', async () => {
      const monitor = createMonitor();

      // HWM at 100k
      await monitor.update(makePortfolio(100_000, 0), 'u1', 's1');
      // Drop to 89k (11% drawdown, threshold is 10%)
      await monitor.update(makePortfolio(80_000, 9_000), 'u1', 's1');

      expect(killSwitch.trigger).toHaveBeenCalledWith(
        { type: 'USER', userId: 'u1' },
        expect.stringContaining('exceeded threshold'),
        'loss-monitor',
      );
    });

    it('should emit LOSS_LIMIT_BREACHED when threshold exceeded', async () => {
      const monitor = createMonitor();

      await monitor.update(makePortfolio(100_000, 0), 'u1', 's1');
      await monitor.update(makePortfolio(80_000, 9_000), 'u1', 's1');

      expect(alertBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: SecurityEventType.LOSS_LIMIT_BREACHED,
        }),
      );
    });

    it('should not trigger kill switch when drawdown is below threshold', async () => {
      const monitor = createMonitor();

      await monitor.update(makePortfolio(100_000, 0), 'u1', 's1');
      await monitor.update(makePortfolio(95_000, 0), 'u1', 's1');

      expect(killSwitch.trigger).not.toHaveBeenCalled();
    });

    it('should trigger kill switch at exactly threshold boundary', async () => {
      const monitor = createMonitor();

      await monitor.update(makePortfolio(100_000, 0), 'u1', 's1');
      // Exactly 10% drawdown
      await monitor.update(makePortfolio(90_000, 0), 'u1', 's1');

      expect(killSwitch.trigger).toHaveBeenCalled();
    });
  });

  describe('getDrawdown', () => {
    it('should return 0 when no data exists', async () => {
      const monitor = createMonitor();
      const dd = await monitor.getDrawdown('nonexistent');
      expect(dd).toBe(0);
    });

    it('should return the persisted drawdown percentage', async () => {
      const monitor = createMonitor();
      await monitor.update(makePortfolio(100_000, 0), 'u1', 's1');
      await monitor.update(makePortfolio(92_000, 0), 'u1', 's1');

      const dd = await monitor.getDrawdown('u1');
      expect(dd).toBe(8);
    });
  });

  describe('resetWatermark', () => {
    it('should clear high watermark and drawdown data', async () => {
      const monitor = createMonitor();
      await monitor.update(makePortfolio(100_000, 0), 'u1', 's1');
      await monitor.update(makePortfolio(92_000, 0), 'u1', 's1');

      await monitor.resetWatermark('u1');
      const dd = await monitor.getDrawdown('u1');
      expect(dd).toBe(0);
    });

    it('should log the reset', async () => {
      const monitor = createMonitor();
      await monitor.resetWatermark('u1');
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('High watermark reset'),
        expect.objectContaining({ userId: 'u1' }),
      );
    });
  });
});
