import { Injectable, Optional, Logger } from '@nestjs/common';
import { safeGet } from './security-config';
import { ConfigService } from '@nestjs/config';
import {
  WashTradeDetector,
  LayeringDetector,
  ShortSellControl,
  TradeReporter,
  LocalJsonlTradeReporter,
  AccountType,
  type PlaceOrderAction,
  type PortfolioSnapshot,
  type WashTradeCheckResult,
  type ShortSellCheckResult,
  type LayeringCheckResult,
  type SecurityConfig,
} from '@super-ai/security';
import { SecurityRedisService } from './security-redis.service';
import { SecurityAlertService } from './security-alert.service';
import * as fs from 'fs';

/**
 * NestJS wrapper around compliance checks from @super-ai/security.
 * Detects wash trades, layering, enforces short-sell controls, and reports trades.
 */
@Injectable()
export class SecurityComplianceService {
  private readonly logger = new Logger(SecurityComplianceService.name);
  private washTradeDetector!: WashTradeDetector;
  private layeringDetector!: LayeringDetector;
  private shortSellControl!: ShortSellControl;
  private tradeReporter!: TradeReporter;

  constructor(
    private readonly config: ConfigService,
    private readonly redis: SecurityRedisService,
    private readonly alertService: SecurityAlertService,
  ) {}

  safeInit(): void {
    const securityConfig = this.buildConfig();
    const nestLogger = this.logger;
    const loggerAdapter = {
      info: (msg: string, meta?: Record<string, unknown>) =>
        nestLogger.log(msg, meta),
      warn: (msg: string, meta?: Record<string, unknown>) =>
        nestLogger.warn(msg, meta),
      error: (msg: string, meta?: Record<string, unknown>) =>
        nestLogger.error(msg, meta),
    };

    const alertBus = this.alertService.getBus();
    const alertBusAdapter = {
      emit: (alert: {
        level: string;
        type: string;
        message: string;
        correlationId: string;
        metadata: Record<string, unknown>;
      }) => {
        alertBus
          .emit({
            eventType: alert.type,
            riskLevel: alert.level as any,
            description: alert.message,
            payload: { correlationId: alert.correlationId, ...alert.metadata },
            timestamp: new Date().toISOString(),
          })
          .catch((err) =>
            nestLogger.error(`Alert emission failed: ${(err as Error).message}`),
          );
      },
    };

    this.washTradeDetector = new WashTradeDetector(
      securityConfig,
      loggerAdapter,
      this.redis,
      alertBusAdapter,
    );

    this.layeringDetector = new LayeringDetector(
      securityConfig,
      loggerAdapter,
      this.redis,
      alertBusAdapter,
    );

    this.shortSellControl = new ShortSellControl(loggerAdapter, alertBusAdapter);

    // Trade reporter with local JSONL adapter
    const reportPath = this.config?.get<string>(
      'TRADE_REPORT_PATH',
      './data/trade-reports.jsonl',
    );
    const fsAdapter = {
      appendFile: async (path: string, data: string) => {
        await fs.promises.appendFile(path, data);
      },
    };
    const localReporter = new LocalJsonlTradeReporter(reportPath, fsAdapter);
    this.tradeReporter = new TradeReporter(
      [localReporter],
      loggerAdapter,
      alertBusAdapter,
    );

    this.logger.log('SecurityComplianceService initialized');
  }

  /**
   * Check if a trade action looks like a wash trade.
   */
  async checkWashTrade(
    action: PlaceOrderAction,
    userId: string,
  ): Promise<WashTradeCheckResult> {
    return this.washTradeDetector.check(action, userId);
  }

  /**
   * Check if a trade action violates short-sell controls.
   */
  async checkShortSell(
    action: PlaceOrderAction,
    portfolio: PortfolioSnapshot,
    accountType: AccountType,
  ): Promise<ShortSellCheckResult> {
    return this.shortSellControl.check(action, portfolio, accountType);
  }

  /**
   * Check for layering / spoofing patterns.
   */
  async checkLayering(
    userId: string,
    instrument: string,
  ): Promise<LayeringCheckResult> {
    // strategyId defaults to 'default' for the check
    return this.layeringDetector.check(userId, instrument, 'default');
  }

  /**
   * Record an order for compliance tracking (wash trade + layering detection).
   */
  async recordOrder(
    action: PlaceOrderAction,
    userId: string,
  ): Promise<void> {
    await this.layeringDetector.recordOrder(action, userId);
  }

  /**
   * Record an order cancellation for layering detection.
   */
  async recordCancellation(
    clientOrderId: string,
    userId: string,
    instrument: string,
  ): Promise<void> {
    await this.layeringDetector.recordCancellation(
      clientOrderId,
      userId,
      instrument,
    );
  }

  /**
   * Get the trade reporter for direct use by other services.
   */
  getTradeReporter(): TradeReporter {
    return this.tradeReporter;
  }

  private buildConfig(): SecurityConfig {
    return {
      jwtPublicKeyPath: safeGet<string>(this.config, 'JWT_PUBLIC_KEY_PATH', './keys/jwt.pub'),
      jwtPrivateKeyPath: safeGet<string>(this.config, 'JWT_PRIVATE_KEY_PATH', './keys/jwt.key'),
      hmacChainSecret: safeGet<string>(this.config, 'HMAC_CHAIN_SECRET', 'dev-hmac-secret-change-me'),
      signingPrivateKey: safeGet<string>(this.config, 'SIGNING_PRIVATE_KEY', 'dev-signing-private-key'),
      signingPublicKey: safeGet<string>(this.config, 'SIGNING_PUBLIC_KEY', 'dev-signing-public-key'),
      adminUserId: safeGet<string>(this.config, 'ADMIN_USER_ID', 'admin'),
      washTradeDetectionWindowMs: safeGet<number>(this.config, 'WASH_TRADE_WINDOW_MS', 30_000),
      layeringDetectionWindowMs: safeGet<number>(this.config, 'LAYERING_WINDOW_MS', 60_000),
      layeringCancelRatioThreshold: safeGet<number>(this.config, 'LAYERING_CANCEL_RATIO', 0.7),
      environment: safeGet<'development' | 'staging' | 'production'>(this.config, 'NODE_ENV', 'development') as 'development' | 'staging' | 'production',
    } as SecurityConfig;
  }
}
