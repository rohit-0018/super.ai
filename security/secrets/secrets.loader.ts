import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { KmsAdapter } from './kms.adapter.js';
import { SecurityEventType, RiskLevel } from '../types/events.js';
import { SecretsError } from '../types/errors.js';
import { SecurityErrorCode } from '../types/errors.js';

// ─── Dependency interfaces ──────────────────────────────────────────────────

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
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

// ─── Config subset for SecretsLoader ────────────────────────────────────────

export interface SecretsLoaderConfig {
  requiredSecrets: readonly string[];
  kmsProvider: 'local' | 'aws';
}

// ─── Loaded secrets schema ──────────────────────────────────────────────────

const LoadedSecretsSchema = z.record(z.string(), z.string().min(1));

export type LoadedSecrets = z.infer<typeof LoadedSecretsSchema>;

// ─── SecretsLoader ──────────────────────────────────────────────────────────

export class SecretsLoader {
  private readonly kmsAdapter: KmsAdapter;
  private readonly config: SecretsLoaderConfig;
  private readonly logger: Logger;
  private readonly alertBus: AlertBus;
  private readonly store: Map<string, string> = new Map();

  constructor(
    kmsAdapter: KmsAdapter,
    config: SecretsLoaderConfig,
    logger: Logger,
    alertBus: AlertBus,
  ) {
    this.kmsAdapter = kmsAdapter;
    this.config = config;
    this.logger = logger;
    this.alertBus = alertBus;
  }

  public async load(): Promise<LoadedSecrets> {
    const loaded: Record<string, string> = {};
    const missing: string[] = [];
    const failed: string[] = [];

    for (const secretName of this.config.requiredSecrets) {
      try {
        const value = await this.kmsAdapter.getSecret(secretName);
        loaded[secretName] = value;
        this.store.set(secretName, value);

        this.logger.info(`Secret loaded successfully`, {
          secretName,
          provider: this.config.kmsProvider,
        });

        const correlationId = randomUUID();
        this.alertBus.emit({
          level: RiskLevel.LOW,
          type: SecurityEventType.SECRET_LOADED,
          message: `Secret ${secretName} loaded via ${this.config.kmsProvider}`,
          correlationId,
          metadata: {
            secretName,
            provider: this.config.kmsProvider,
          },
        });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';

        if (errorMessage.includes('is not set')) {
          missing.push(secretName);
        } else {
          failed.push(secretName);
        }

        this.logger.error(`Failed to load secret`, {
          secretName,
          error: errorMessage,
        });
      }
    }

    const unavailable = [...missing, ...failed];
    if (unavailable.length > 0) {
      throw new SecretsError(
        `Missing or failed secrets: [${unavailable.join(', ')}]`,
        randomUUID(),
        SecurityErrorCode.SECRET_NOT_FOUND,
        { missingKeys: unavailable },
      );
    }

    // Validate the full record shape
    const validated = LoadedSecretsSchema.parse(loaded);
    return validated;
  }

  public get(key: string): string {
    const value = this.store.get(key);
    if (value === undefined) {
      throw new SecretsError(
        `Secret ${key} not found in store`,
        randomUUID(),
        SecurityErrorCode.SECRET_NOT_FOUND,
        { key },
      );
    }
    return value;
  }

  public async reload(keyName: string): Promise<void> {
    this.logger.info(`Reloading secret`, { secretName: keyName });

    try {
      const value = await this.kmsAdapter.getSecret(keyName);
      this.store.set(keyName, value);

      this.logger.info(`Secret reloaded successfully`, {
        secretName: keyName,
        provider: this.config.kmsProvider,
      });

      const correlationId = randomUUID();
      this.alertBus.emit({
        level: RiskLevel.LOW,
        type: SecurityEventType.SECRET_LOADED,
        message: `Secret ${keyName} reloaded via ${this.config.kmsProvider}`,
        correlationId,
        metadata: {
          secretName: keyName,
          provider: this.config.kmsProvider,
        },
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      this.logger.error(`Failed to reload secret`, {
        secretName: keyName,
        error: errorMessage,
      });

      throw new SecretsError(
        `Failed to reload secret ${keyName}`,
        randomUUID(),
        SecurityErrorCode.SECRET_DECRYPTION_FAILED,
        { secretName: keyName },
      );
    }
  }
}
