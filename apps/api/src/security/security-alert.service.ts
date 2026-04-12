import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AlertBus,
  LogAlertConsumer,
  SlackAlertConsumer,
  type AnomalyEvent,
} from '@super-ai/security';

/**
 * NestJS wrapper around AlertBus from @super-ai/security.
 * Provides a central event bus for security alerts. Registers consumers
 * (logging, Slack, etc.) based on available configuration.
 */
@Injectable()
export class SecurityAlertService {
  private readonly logger = new Logger(SecurityAlertService.name);
  private alertBus!: AlertBus;

  constructor(private readonly config: ConfigService) {}

  private env(key: string, fallback = ''): string {
    return this.config?.get<string>(key) ?? process.env[key] ?? fallback;
  }

  safeInit(): void {
    const nestLogger = this.logger;
    const loggerAdapter = {
      info: (msg: string, data?: Record<string, unknown>) =>
        nestLogger.log(msg, data),
      warn: (msg: string, data?: Record<string, unknown>) =>
        nestLogger.warn(msg, data),
      error: (msg: string, data?: Record<string, unknown>) =>
        nestLogger.error(msg, data),
    };

    this.alertBus = new AlertBus(loggerAdapter);

    // Always register log consumer
    const logConsumer = new LogAlertConsumer({
      log: (message: string, data: Record<string, unknown>) =>
        nestLogger.log(`[AUDIT] ${message}`, data),
    });
    this.alertBus.register(logConsumer);

    // Register Slack consumer if configured
    const slackUrl = this.env('ALERT_SLACK_WEBHOOK_URL');
    if (slackUrl) {
      const fetch = globalThis.fetch;
      const httpClient = {
        post: async (
          url: string,
          body: string,
          headers: Record<string, string>,
        ) => {
          const res = await fetch(url, {
            method: 'POST',
            body,
            headers,
          });
          return { status: res.status };
        },
      };
      const slackConsumer = new SlackAlertConsumer(slackUrl, httpClient);
      this.alertBus.register(slackConsumer);
      this.logger.log('Slack alert consumer registered');
    }

    this.logger.log('SecurityAlertService initialized');
  }

  /**
   * Emit a security alert to all registered consumers.
   */
  async emit(event: AnomalyEvent): Promise<void> {
    await this.alertBus.emit(event);
  }

  /**
   * Get the underlying AlertBus instance (for components that need it directly).
   */
  getBus(): AlertBus {
    return this.alertBus;
  }
}
