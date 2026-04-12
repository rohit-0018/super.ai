import { createHmac } from 'node:crypto';
import { RiskLevel } from '../types/events.js';

// ─── AnomalyEvent ──────────────────────────────────────────────────────────

export interface AnomalyEvent {
  readonly eventType: string;
  readonly riskLevel: RiskLevel;
  readonly userId?: string;
  readonly strategyId?: string;
  readonly description: string;
  readonly payload: Record<string, unknown>;
  readonly timestamp: string;
}

// ─── AlertConsumer Interface ───────────────────────────────────────────────

export interface AlertConsumer {
  consume(event: AnomalyEvent): Promise<void>;
}

// ─── AuditLogger Interface (minimal for alert bus) ─────────────────────────

export interface AuditLoggerPort {
  log(message: string, data: Record<string, unknown>): void;
}

// ─── Logger Interface ──────────────────────────────────────────────────────

export interface AlertBusLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

// ─── HttpClient Interface ──────────────────────────────────────────────────

export interface HttpClient {
  post(url: string, body: string, headers: Record<string, string>): Promise<{ status: number }>;
}

// ─── AlertBus ──────────────────────────────────────────────────────────────

export class AlertBus {
  private readonly consumers: AlertConsumer[] = [];
  private readonly logger: AlertBusLogger;

  constructor(logger: AlertBusLogger) {
    this.logger = logger;
  }

  register(consumer: AlertConsumer): void {
    this.consumers.push(consumer);
  }

  async emit(event: AnomalyEvent): Promise<void> {
    const results = await Promise.allSettled(
      this.consumers.map((consumer) => consumer.consume(event)),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result !== undefined && result.status === 'rejected') {
        this.logger.error('AlertConsumer failed', {
          consumerIndex: i,
          reason: result.reason instanceof Error ? result.reason.message : String(result.reason),
          eventType: event.eventType,
        });
      }
    }
  }
}

// ─── WebhookAlertConsumer ──────────────────────────────────────────────────

export class WebhookAlertConsumer implements AlertConsumer {
  private readonly webhookUrl: string;
  private readonly hmacSecret: string;
  private readonly httpClient: HttpClient;

  constructor(webhookUrl: string, hmacSecret: string, httpClient: HttpClient) {
    this.webhookUrl = webhookUrl;
    this.hmacSecret = hmacSecret;
    this.httpClient = httpClient;
  }

  async consume(event: AnomalyEvent): Promise<void> {
    const body = JSON.stringify(event);
    const signature = createHmac('sha256', this.hmacSecret)
      .update(body)
      .digest('hex');

    await this.httpClient.post(this.webhookUrl, body, {
      'Content-Type': 'application/json',
      'X-Signature-SHA256': signature,
    });
  }
}

// ─── SlackAlertConsumer ────────────────────────────────────────────────────

export class SlackAlertConsumer implements AlertConsumer {
  private readonly slackWebhookUrl: string;
  private readonly httpClient: HttpClient;

  constructor(slackWebhookUrl: string, httpClient: HttpClient) {
    this.slackWebhookUrl = slackWebhookUrl;
    this.httpClient = httpClient;
  }

  async consume(event: AnomalyEvent): Promise<void> {
    const text = `[${event.riskLevel}] ${event.eventType}: ${event.description}`;
    const body = JSON.stringify({ text });

    await this.httpClient.post(this.slackWebhookUrl, body, {
      'Content-Type': 'application/json',
    });
  }
}

// ─── EmailAlertConsumer (interface only) ───────────────────────────────────

export interface EmailTransport {
  send(to: string, subject: string, body: string): Promise<void>;
}

export class EmailAlertConsumer implements AlertConsumer {
  private readonly transport: EmailTransport;
  private readonly recipientEmail: string;

  constructor(transport: EmailTransport, recipientEmail: string) {
    this.transport = transport;
    this.recipientEmail = recipientEmail;
  }

  async consume(event: AnomalyEvent): Promise<void> {
    const subject = `[${event.riskLevel}] Security Alert: ${event.eventType}`;
    const body = JSON.stringify(event, null, 2);
    await this.transport.send(this.recipientEmail, subject, body);
  }
}

// ─── LogAlertConsumer ──────────────────────────────────────────────────────

export class LogAlertConsumer implements AlertConsumer {
  private readonly auditLogger: AuditLoggerPort;

  constructor(auditLogger: AuditLoggerPort) {
    this.auditLogger = auditLogger;
  }

  async consume(event: AnomalyEvent): Promise<void> {
    this.auditLogger.log(`Alert: ${event.eventType}`, {
      riskLevel: event.riskLevel,
      userId: event.userId,
      strategyId: event.strategyId,
      description: event.description,
      payload: event.payload,
      timestamp: event.timestamp,
    });
  }
}
