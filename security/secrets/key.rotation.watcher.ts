import { randomUUID } from 'node:crypto';
import type { ScheduledTask } from 'node-cron';
import cron from 'node-cron';
import type { KmsAdapter, KeyVersion } from './kms.adapter.js';
import type { SecretsLoader } from './secrets.loader.js';
import { SecurityEventType, RiskLevel } from '../types/events.js';

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

// ─── Config subset ──────────────────────────────────────────────────────────

export interface KeyRotationWatcherConfig {
  secretsRotationPollIntervalSeconds: number;
  requiredSecrets: readonly string[];
}

// ─── KeyRotationWatcher ─────────────────────────────────────────────────────

export class KeyRotationWatcher {
  private readonly secretsLoader: SecretsLoader;
  private readonly kmsAdapter: KmsAdapter;
  private readonly config: KeyRotationWatcherConfig;
  private readonly logger: Logger;
  private readonly alertBus: AlertBus;
  private readonly knownVersions: Map<string, string> = new Map();
  private cronTask: ScheduledTask | null = null;

  constructor(
    secretsLoader: SecretsLoader,
    kmsAdapter: KmsAdapter,
    config: KeyRotationWatcherConfig,
    logger: Logger,
    alertBus: AlertBus,
  ) {
    this.secretsLoader = secretsLoader;
    this.kmsAdapter = kmsAdapter;
    this.config = config;
    this.logger = logger;
    this.alertBus = alertBus;
  }

  public start(): void {
    if (this.cronTask !== null) {
      this.logger.warn('KeyRotationWatcher already started');
      return;
    }

    const intervalSeconds = this.config.secretsRotationPollIntervalSeconds;
    // node-cron uses cron expression; for interval-based polling,
    // use "*/N * * * * *" for seconds granularity or "*/N * * * *" for minutes
    const cronExpression =
      intervalSeconds < 60
        ? `*/${intervalSeconds} * * * * *`
        : `*/${Math.ceil(intervalSeconds / 60)} * * * *`;

    this.logger.info('Starting key rotation watcher', {
      intervalSeconds,
      cronExpression,
      secrets: [...this.config.requiredSecrets],
    });

    this.cronTask = cron.schedule(cronExpression, () => {
      this.pollForRotations().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        this.logger.error('Unhandled error in poll cycle', { error: msg });
      });
    });
  }

  public stop(): void {
    if (this.cronTask !== null) {
      this.cronTask.stop();
      this.cronTask = null;
      this.logger.info('Key rotation watcher stopped');
    }
  }

  // ─── Internal polling ───────────────────────────────────────────────────

  private async pollForRotations(): Promise<void> {
    for (const secretName of this.config.requiredSecrets) {
      try {
        const versions = await this.kmsAdapter.listKeyVersions(secretName);
        const latestVersion = this.findLatestVersion(versions);

        if (latestVersion === null) {
          continue;
        }

        const knownVersion = this.knownVersions.get(secretName);

        if (knownVersion === undefined) {
          // First time seeing this secret's version; record it
          this.knownVersions.set(secretName, latestVersion.versionId);
          continue;
        }

        if (knownVersion !== latestVersion.versionId) {
          const previousVersion = knownVersion;
          this.knownVersions.set(secretName, latestVersion.versionId);

          this.logger.info('Secret rotation detected', {
            secretName,
            previousVersion,
            newVersion: latestVersion.versionId,
          });

          const correlationId = randomUUID();
          this.alertBus.emit({
            level: RiskLevel.MEDIUM,
            type: SecurityEventType.SECRET_ROTATION_DETECTED,
            message: `Rotation detected for secret ${secretName}`,
            correlationId,
            metadata: {
              secretName,
              previousVersion,
              newVersion: latestVersion.versionId,
            },
          });

          await this.secretsLoader.reload(secretName);
        }
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        this.logger.error('Error polling key rotation', {
          secretName,
          error: errorMessage,
        });
      }
    }
  }

  private findLatestVersion(versions: KeyVersion[]): KeyVersion | null {
    if (versions.length === 0) {
      return null;
    }

    let latest = versions[0]!;
    for (let i = 1; i < versions.length; i++) {
      const v = versions[i]!;
      if (v.createdAt > latest.createdAt) {
        latest = v;
      }
    }
    return latest;
  }
}
