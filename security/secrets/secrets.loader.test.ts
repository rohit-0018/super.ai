import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SecretsLoader } from './secrets.loader.js';
import type { SecretsLoaderConfig, Logger, AlertBus } from './secrets.loader.js';
import type { KmsAdapter } from './kms.adapter.js';
import { SecretsError } from '../types/errors.js';
import { SecurityEventType, RiskLevel } from '../types/events.js';

// ─── Mock factories ─────────────────────────────────────────────────────────

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

function createConfig(overrides: Partial<SecretsLoaderConfig> = {}): SecretsLoaderConfig {
  return {
    requiredSecrets: ['API_KEY', 'DB_PASSWORD'],
    kmsProvider: 'local',
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('SecretsLoader', () => {
  let kmsAdapter: ReturnType<typeof createMockKmsAdapter>;
  let logger: ReturnType<typeof createMockLogger>;
  let alertBus: ReturnType<typeof createMockAlertBus>;
  let config: SecretsLoaderConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    kmsAdapter = createMockKmsAdapter();
    logger = createMockLogger();
    alertBus = createMockAlertBus();
    config = createConfig();
  });

  describe('load', () => {
    it('should load all required secrets and return validated record', async () => {
      vi.mocked(kmsAdapter.getSecret)
        .mockResolvedValueOnce('api-key-value')
        .mockResolvedValueOnce('db-password-value');

      const loader = new SecretsLoader(kmsAdapter, config, logger, alertBus);
      const result = await loader.load();

      expect(result).toEqual({
        API_KEY: 'api-key-value',
        DB_PASSWORD: 'db-password-value',
      });
      expect(kmsAdapter.getSecret).toHaveBeenCalledTimes(2);
      expect(kmsAdapter.getSecret).toHaveBeenCalledWith('API_KEY');
      expect(kmsAdapter.getSecret).toHaveBeenCalledWith('DB_PASSWORD');
    });

    it('should emit SECRET_LOADED event for each loaded secret', async () => {
      vi.mocked(kmsAdapter.getSecret)
        .mockResolvedValueOnce('val1')
        .mockResolvedValueOnce('val2');

      const loader = new SecretsLoader(kmsAdapter, config, logger, alertBus);
      await loader.load();

      expect(alertBus.emit).toHaveBeenCalledTimes(2);

      const firstCall = vi.mocked(alertBus.emit).mock.calls[0]?.[0];
      expect(firstCall?.type).toBe(SecurityEventType.SECRET_LOADED);
      expect(firstCall?.level).toBe(RiskLevel.LOW);
      expect(firstCall?.metadata).toEqual(
        expect.objectContaining({ secretName: 'API_KEY' }),
      );

      const secondCall = vi.mocked(alertBus.emit).mock.calls[1]?.[0];
      expect(secondCall?.metadata).toEqual(
        expect.objectContaining({ secretName: 'DB_PASSWORD' }),
      );
    });

    it('should throw SecretsError listing missing keys when secrets are missing', async () => {
      vi.mocked(kmsAdapter.getSecret)
        .mockRejectedValue(new Error('Environment variable is not set'));

      const loader = new SecretsLoader(kmsAdapter, config, logger, alertBus);

      await expect(loader.load()).rejects.toThrow(SecretsError);

      // Reset mock for second assertion call
      vi.mocked(kmsAdapter.getSecret)
        .mockRejectedValue(new Error('Environment variable is not set'));

      await expect(loader.load()).rejects.toThrow('Missing or failed secrets: [API_KEY, DB_PASSWORD]');
    });

    it('should throw SecretsError when decryption fails', async () => {
      vi.mocked(kmsAdapter.getSecret)
        .mockResolvedValueOnce('api-key-value')
        .mockRejectedValueOnce(new Error('KMS decryption failed'));

      const loader = new SecretsLoader(kmsAdapter, config, logger, alertBus);

      await expect(loader.load()).rejects.toThrow(SecretsError);
      await expect(loader.load()).rejects.toThrow('DB_PASSWORD');
    });

    it('should log key names but never values on success', async () => {
      vi.mocked(kmsAdapter.getSecret)
        .mockResolvedValueOnce('secret-api-key')
        .mockResolvedValueOnce('secret-password');

      const loader = new SecretsLoader(kmsAdapter, config, logger, alertBus);
      await loader.load();

      const allInfoCalls = vi.mocked(logger.info).mock.calls;
      for (const call of allInfoCalls) {
        const message = call[0];
        const meta = call[1];
        expect(message).not.toContain('secret-api-key');
        expect(message).not.toContain('secret-password');
        if (meta) {
          const metaStr = JSON.stringify(meta);
          expect(metaStr).not.toContain('secret-api-key');
          expect(metaStr).not.toContain('secret-password');
        }
      }
    });

    it('should log error with key name on failure', async () => {
      vi.mocked(kmsAdapter.getSecret)
        .mockRejectedValueOnce(new Error('Environment variable API_KEY is not set'))
        .mockResolvedValueOnce('val');

      const loader = new SecretsLoader(kmsAdapter, config, logger, alertBus);

      await expect(loader.load()).rejects.toThrow(SecretsError);

      expect(logger.error).toHaveBeenCalledWith(
        'Failed to load secret',
        expect.objectContaining({ secretName: 'API_KEY' }),
      );
    });

    it('should handle empty required secrets list', async () => {
      const emptyConfig = createConfig({ requiredSecrets: [] });
      const loader = new SecretsLoader(kmsAdapter, emptyConfig, logger, alertBus);

      const result = await loader.load();
      expect(result).toEqual({});
      expect(kmsAdapter.getSecret).not.toHaveBeenCalled();
    });
  });

  describe('get', () => {
    it('should return a previously loaded secret', async () => {
      vi.mocked(kmsAdapter.getSecret)
        .mockResolvedValueOnce('api-key-value')
        .mockResolvedValueOnce('db-password-value');

      const loader = new SecretsLoader(kmsAdapter, config, logger, alertBus);
      await loader.load();

      expect(loader.get('API_KEY')).toBe('api-key-value');
      expect(loader.get('DB_PASSWORD')).toBe('db-password-value');
    });

    it('should throw SecretsError for unknown key', () => {
      const loader = new SecretsLoader(kmsAdapter, config, logger, alertBus);

      expect(() => loader.get('NONEXISTENT')).toThrow(SecretsError);
      expect(() => loader.get('NONEXISTENT')).toThrow('Secret NONEXISTENT not found in store');
    });
  });

  describe('reload', () => {
    it('should reload a specific secret and update the store', async () => {
      vi.mocked(kmsAdapter.getSecret)
        .mockResolvedValueOnce('old-api-key')
        .mockResolvedValueOnce('db-password')
        .mockResolvedValueOnce('new-api-key');

      const loader = new SecretsLoader(kmsAdapter, config, logger, alertBus);
      await loader.load();

      expect(loader.get('API_KEY')).toBe('old-api-key');

      await loader.reload('API_KEY');

      expect(loader.get('API_KEY')).toBe('new-api-key');
    });

    it('should emit SECRET_LOADED event on successful reload', async () => {
      vi.mocked(kmsAdapter.getSecret)
        .mockResolvedValueOnce('val1')
        .mockResolvedValueOnce('val2')
        .mockResolvedValueOnce('new-val1');

      const loader = new SecretsLoader(kmsAdapter, config, logger, alertBus);
      await loader.load();

      vi.mocked(alertBus.emit).mockClear();

      await loader.reload('API_KEY');

      expect(alertBus.emit).toHaveBeenCalledTimes(1);
      const call = vi.mocked(alertBus.emit).mock.calls[0]?.[0];
      expect(call?.type).toBe(SecurityEventType.SECRET_LOADED);
      expect(call?.metadata).toEqual(
        expect.objectContaining({ secretName: 'API_KEY' }),
      );
    });

    it('should throw SecretsError when reload fails', async () => {
      vi.mocked(kmsAdapter.getSecret)
        .mockResolvedValueOnce('val1')
        .mockResolvedValueOnce('val2');

      const loader = new SecretsLoader(kmsAdapter, config, logger, alertBus);
      await loader.load();

      // Set persistent rejection for reload attempts
      vi.mocked(kmsAdapter.getSecret).mockRejectedValue(new Error('KMS unavailable'));

      await expect(loader.reload('API_KEY')).rejects.toThrow(SecretsError);
      await expect(
        loader.reload('API_KEY'),
      ).rejects.toThrow('Failed to reload secret API_KEY');
    });

    it('should preserve old value in store when reload fails', async () => {
      vi.mocked(kmsAdapter.getSecret)
        .mockResolvedValueOnce('original-value')
        .mockResolvedValueOnce('db-password')
        .mockRejectedValueOnce(new Error('KMS unavailable'));

      const loader = new SecretsLoader(kmsAdapter, config, logger, alertBus);
      await loader.load();

      try {
        await loader.reload('API_KEY');
      } catch {
        // expected
      }

      expect(loader.get('API_KEY')).toBe('original-value');
    });
  });
});
