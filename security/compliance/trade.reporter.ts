import { randomUUID, createHmac } from 'node:crypto';
import { SecurityEventType, RiskLevel } from '../types/events.js';

// ─── Interfaces ─────────────────────────────────────────────────────────────

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

export interface FileSystem {
  appendFile(path: string, data: string): Promise<void>;
}

export interface HttpClient {
  post(url: string, options: {
    headers: Record<string, string>;
    body: string;
  }): Promise<{ status: number; statusText: string }>;
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ExecutedTrade {
  tradeId: string;
  userId: string;
  strategyId: string;
  instrument: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  notional: number;
  timestamp: string;
  orderId: string;
  settlementDate: string;
}

// ─── Adapter interface ──────────────────────────────────────────────────────

export interface TradeReportingAdapter {
  report(trade: ExecutedTrade): Promise<void>;
}

// ─── LocalJsonlTradeReporter ────────────────────────────────────────────────

export class LocalJsonlTradeReporter implements TradeReportingAdapter {
  private readonly filePath: string;
  private readonly fs: FileSystem;

  constructor(filePath: string, fs: FileSystem) {
    this.filePath = filePath;
    this.fs = fs;
  }

  public async report(trade: ExecutedTrade): Promise<void> {
    const line = JSON.stringify(trade) + '\n';
    await this.fs.appendFile(this.filePath, line);
  }
}

// ─── WebhookTradeReporter ───────────────────────────────────────────────────

export class WebhookTradeReporter implements TradeReportingAdapter {
  private readonly url: string;
  private readonly hmacSecret: string;
  private readonly httpClient: HttpClient;

  constructor(url: string, hmacSecret: string, httpClient: HttpClient) {
    this.url = url;
    this.hmacSecret = hmacSecret;
    this.httpClient = httpClient;
  }

  public async report(trade: ExecutedTrade): Promise<void> {
    const body = JSON.stringify(trade);
    const signature = createHmac('sha256', this.hmacSecret)
      .update(body)
      .digest('hex');

    const response = await this.httpClient.post(this.url, {
      headers: {
        'Content-Type': 'application/json',
        'X-Signature': signature,
      },
      body,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `Trade reporting webhook failed: ${response.status} ${response.statusText}`,
      );
    }
  }
}

// ─── TradeReporter (orchestrator) ───────────────────────────────────────────

export class TradeReporter {
  private readonly adapters: readonly TradeReportingAdapter[];
  private readonly logger: Logger;
  private readonly alertBus: AlertBus;

  constructor(
    adapters: readonly TradeReportingAdapter[],
    logger: Logger,
    alertBus: AlertBus,
  ) {
    this.adapters = adapters;
    this.logger = logger;
    this.alertBus = alertBus;
  }

  public async report(trade: ExecutedTrade): Promise<void> {
    const errors: Error[] = [];

    for (const adapter of this.adapters) {
      try {
        await adapter.report(trade);
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        errors.push(error);
        this.logger.error(`Trade reporting adapter failed: ${error.message}`, {
          tradeId: trade.tradeId,
          instrument: trade.instrument,
        });
      }
    }

    if (errors.length === this.adapters.length && this.adapters.length > 0) {
      throw new Error(
        `All trade reporting adapters failed for trade ${trade.tradeId}`,
      );
    }

    const correlationId = randomUUID();

    this.logger.info('Trade reported successfully', {
      tradeId: trade.tradeId,
      instrument: trade.instrument,
      side: trade.side,
      quantity: trade.quantity,
      price: trade.price,
      correlationId,
    });

    this.alertBus.emit({
      level: RiskLevel.LOW,
      type: SecurityEventType.TRADE_REPORTED,
      message: `Trade ${trade.tradeId} reported for ${trade.instrument}`,
      correlationId,
      metadata: {
        tradeId: trade.tradeId,
        instrument: trade.instrument,
        side: trade.side,
        quantity: trade.quantity,
        price: trade.price,
        venue: 'default',
        reportedTo: this.adapters.length > 0 ? 'configured-adapters' : 'none',
      },
    });
  }
}
