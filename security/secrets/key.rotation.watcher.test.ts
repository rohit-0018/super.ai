import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KeyRotationWatcher } from './key.rotation.watcher.js';
import type { KeyRotationWatcherConfig, Logger, AlertBus } from './key.rotation.watcher.js';
import type { KmsAdapter, KeyVersion } from './kms.adapter.js';
import type { SecretsLoader } from './secrets.loader.js';
import { SecurityEventType, RiskLevel } from '../types/events.js';

// ─── Mock node-cron ─────────────────────────────────────────────────────────

const mockStop = vi.fn();
let capturedCronCallback: (() => void) | null = null;
const mockSchedule = vi.fn((expression: string, callback: () => void) => {
  capturedCronCallback = callback;
  return { stop: mockStop };
});

/** Flush all pending microtasks so fire-and-forget promises resolve */
function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

vi.mock('node-cron', () => ({
  default: {
    schedule: (...args: unknown[]) => mockSchedule(...(args as [string, () => void])),
  },
}));

// ─── Mock factories ─────────────────────────────────────────────────────────

function createMockSecretsLoader(): Pick<SecretsLoader, 'reload'> {
  return {
    reload: vi.fn(),
  };
}

function createMockKmsAdapter(): KmsAdapter {
  return {
    getSecret: vi.fn(),
    listKeyVersions: vi.fn(),
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

function createConfig(overrides: Partial<KeyRotationWatcherConfig> = {}): KeyRotationWatcherConfig {
  return {
    secretsRotationPollIntervalSeconds: 300,
    requiredSecrets: ['API_KEY', 'DB_PASSWORD'],
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('KeyRotationWatcher', () => {
  let secretsLoader: ReturnType<typeof createMockSecretsLoader>;
  let kmsAdapter: ReturnType<typeof createMockKmsAdapter>;
  let logger: ReturnType<typeof createMockLogger>;
  let alertBus: ReturnType<typeof createMockAlertBus>;
  let config: KeyRotationWatcherConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedCronCallback = null;
    secretsLoader = createMockSecretsLoader();
    kmsAdapter = createMockKmsAdapter();
    logger = createMockLogger();
    alertBus = createMockAlertBus();
    config = createConfig();
  });

  afterEach(() => {
    capturedCronCallback = null;
  });

  describe('start', () => {
    it('should schedule a cron task with the configured interval', () => {
      const watcher = new KeyRotationWatcher(
        secretsLoader as unknown as SecretsLoader, // mock boundary
        kmsAdapter,
        config,
        logger,
        alertBus,
      );

      watcher.start();

      expect(mockSchedule).toHaveBeenCalledTimes(1);
      expect(mockSchedule).toHaveBeenCalledWith(
        '*/5 * * * *', // 300s = 5min
        expect.any(Function),
      );
    });

    it('should use seconds expression for intervals under 60s', () => {
      const shortConfig = createConfig({ secretsRotationPollIntervalSeconds: 30 });

      const watcher = new KeyRotationWatcher(
        secretsLoader as unknown as SecretsLoader, // mock boundary
        kmsAdapter,
        shortConfig,
        logger,
        alertBus,
      );

      watcher.start();

      expect(mockSchedule).toHaveBeenCalledWith(
        '*/30 * * * * *',
        expect.any(Function),
      );
    });

    it('should warn and not start a second cron task if already started', () => {
      const watcher = new KeyRotationWatcher(
        secretsLoader as unknown as SecretsLoader, // mock boundary
        kmsAdapter,
        config,
        logger,
        alertBus,
      );

      watcher.start();
      watcher.start();

      expect(logger.warn).toHaveBeenCalledWith('KeyRotationWatcher already started');
    });
  });

  describe('stop', () => {
    it('should stop the cron task', () => {
      const watcher = new KeyRotationWatcher(
        secretsLoader as unknown as SecretsLoader, // mock boundary
        kmsAdapter,
        config,
        logger,
        alertBus,
      );

      watcher.start();
      watcher.stop();

      expect(mockStop).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith('Key rotation watcher stopped');
    });

    it('should do nothing if not started', () => {
      const watcher = new KeyRotationWatcher(
        secretsLoader as unknown as SecretsLoader, // mock boundary
        kmsAdapter,
        config,
        logger,
        alertBus,
      );

      watcher.stop();

      expect(mockStop).not.toHaveBeenCalled();
    });
  });

  describe('polling', () => {
    it('should record initial versions without triggering rotation', async () => {
      const versions: KeyVersion[] = [
        { versionId: 'v1', createdAt: '2025-01-01T00:00:00Z', status: 'Active' },
      ];
      vi.mocked(kmsAdapter.listKeyVersions).mockResolvedValue(versions);

      const watcher = new KeyRotationWatcher(
        secretsLoader as unknown as SecretsLoader, // mock boundary
        kmsAdapter,
        config,
        logger,
        alertBus,
      );

      watcher.start();
      expect(capturedCronCallback).not.toBeNull();

      // First poll: records initial versions
      capturedCronCallback!(); await flushPromises();

      expect(alertBus.emit).not.toHaveBeenCalled();
      expect(secretsLoader.reload).not.toHaveBeenCalled();
    });

    it('should detect rotation and reload secret when version changes', async () => {
      const initialVersions: KeyVersion[] = [
        { versionId: 'v1', createdAt: '2025-01-01T00:00:00Z', status: 'Active' },
      ];
      const rotatedVersions: KeyVersion[] = [
        { versionId: 'v2', createdAt: '2025-02-01T00:00:00Z', status: 'Active' },
      ];

      vi.mocked(kmsAdapter.listKeyVersions)
        .mockResolvedValueOnce(initialVersions) // API_KEY first poll
        .mockResolvedValueOnce(initialVersions) // DB_PASSWORD first poll
        .mockResolvedValueOnce(rotatedVersions) // API_KEY second poll - rotated
        .mockResolvedValueOnce(initialVersions); // DB_PASSWORD second poll - same

      const watcher = new KeyRotationWatcher(
        secretsLoader as unknown as SecretsLoader, // mock boundary
        kmsAdapter,
        config,
        logger,
        alertBus,
      );

      watcher.start();

      // First poll: seed versions
      capturedCronCallback!(); await flushPromises();
      expect(alertBus.emit).not.toHaveBeenCalled();

      // Second poll: detect rotation for API_KEY
      capturedCronCallback!(); await flushPromises();

      expect(alertBus.emit).toHaveBeenCalledTimes(1);
      const emitCall = vi.mocked(alertBus.emit).mock.calls[0]?.[0];
      expect(emitCall?.type).toBe(SecurityEventType.SECRET_ROTATION_DETECTED);
      expect(emitCall?.level).toBe(RiskLevel.MEDIUM);
      expect(emitCall?.metadata).toEqual(
        expect.objectContaining({
          secretName: 'API_KEY',
          previousVersion: 'v1',
          newVersion: 'v2',
        }),
      );

      expect(secretsLoader.reload).toHaveBeenCalledWith('API_KEY');
      expect(secretsLoader.reload).toHaveBeenCalledTimes(1);
    });

    it('should skip secrets with no versions', async () => {
      vi.mocked(kmsAdapter.listKeyVersions).mockResolvedValue([]);

      const watcher = new KeyRotationWatcher(
        secretsLoader as unknown as SecretsLoader, // mock boundary
        kmsAdapter,
        config,
        logger,
        alertBus,
      );

      watcher.start();
      capturedCronCallback!(); await flushPromises();

      expect(alertBus.emit).not.toHaveBeenCalled();
      expect(secretsLoader.reload).not.toHaveBeenCalled();
    });

    it('should handle errors during polling gracefully', async () => {
      vi.mocked(kmsAdapter.listKeyVersions)
        .mockRejectedValueOnce(new Error('KMS unavailable'))
        .mockResolvedValueOnce([
          { versionId: 'v1', createdAt: '2025-01-01T00:00:00Z', status: 'Active' },
        ]);

      const watcher = new KeyRotationWatcher(
        secretsLoader as unknown as SecretsLoader, // mock boundary
        kmsAdapter,
        config,
        logger,
        alertBus,
      );

      watcher.start();
      capturedCronCallback!(); await flushPromises();

      expect(logger.error).toHaveBeenCalledWith(
        'Error polling key rotation',
        expect.objectContaining({
          secretName: 'API_KEY',
          error: 'KMS unavailable',
        }),
      );

      // DB_PASSWORD should still have been processed
      expect(kmsAdapter.listKeyVersions).toHaveBeenCalledTimes(2);
    });

    it('should select the latest version by createdAt', async () => {
      const multipleVersions: KeyVersion[] = [
        { versionId: 'v1', createdAt: '2025-01-01T00:00:00Z', status: 'Active' },
        { versionId: 'v3', createdAt: '2025-03-01T00:00:00Z', status: 'Active' },
        { versionId: 'v2', createdAt: '2025-02-01T00:00:00Z', status: 'Active' },
      ];

      vi.mocked(kmsAdapter.listKeyVersions).mockResolvedValue(multipleVersions);

      const singleConfig = createConfig({ requiredSecrets: ['API_KEY'] });
      const watcher = new KeyRotationWatcher(
        secretsLoader as unknown as SecretsLoader, // mock boundary
        kmsAdapter,
        singleConfig,
        logger,
        alertBus,
      );

      watcher.start();

      // First poll: records v3 as latest
      capturedCronCallback!(); await flushPromises();

      // Second poll: same versions, no rotation
      capturedCronCallback!(); await flushPromises();

      expect(alertBus.emit).not.toHaveBeenCalled();
    });
  });
});
