import { Injectable, Optional, Logger } from '@nestjs/common';
import { safeGet } from './security-config';
import { ConfigService } from '@nestjs/config';
import {
  RiskEngine,
  CircuitBreaker,
  KillSwitch,
  PositionLimitsChecker,
  LossMonitor,
  type AgentAction,
  type RiskContext,
  type RiskEvaluation,
  type KillSwitchScope,
  type SecurityConfig,
} from '@super-ai/security';
import { SecurityRedisService } from './security-redis.service';
import { SecurityAlertService } from './security-alert.service';

/**
 * NestJS wrapper around the full @super-ai/security risk engine.
 * Manages circuit breakers, kill switch, position limits, and loss monitoring.
 */
@Injectable()
export class RiskEngineService {
  private readonly logger = new Logger(RiskEngineService.name);
  private riskEngine!: RiskEngine;
  private killSwitch!: KillSwitch;

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

    // AlertBus adapter for components that expect the simpler { emit } interface
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

    this.killSwitch = new KillSwitch(
      securityConfig,
      loggerAdapter,
      alertBusAdapter,
      this.redis,
    );

    const positionLimitsChecker = new PositionLimitsChecker(
      securityConfig,
      loggerAdapter,
      alertBusAdapter,
    );

    const lossMonitor = new LossMonitor(
      securityConfig,
      loggerAdapter,
      alertBusAdapter,
      this.killSwitch,
      this.redis,
    );

    const velocityBreaker = new CircuitBreaker(
      'velocity',
      securityConfig.velocityCircuitBreakerOrderCount,
      securityConfig.velocityCircuitBreakerWindowSeconds * 1000,
      30_000, // 30s reset timeout
      loggerAdapter,
      alertBusAdapter,
      this.redis,
    );

    const errorRateBreaker = new CircuitBreaker(
      'error-rate',
      securityConfig.errorRateCircuitBreakerConsecutiveRejectionCount,
      60_000, // 1 min window
      60_000, // 1 min reset timeout
      loggerAdapter,
      alertBusAdapter,
      this.redis,
    );

    const lossBreaker = new CircuitBreaker(
      'loss',
      3, // 3 loss events
      300_000, // 5 min window
      120_000, // 2 min reset timeout
      loggerAdapter,
      alertBusAdapter,
      this.redis,
    );

    this.riskEngine = new RiskEngine(
      securityConfig,
      loggerAdapter,
      alertBusAdapter,
      this.killSwitch,
      positionLimitsChecker,
      lossMonitor,
      velocityBreaker,
      errorRateBreaker,
      lossBreaker,
    );

    this.logger.log('RiskEngineService initialized');
  }

  /**
   * Evaluate an agent action against all risk controls.
   */
  async evaluate(
    action: AgentAction,
    context: RiskContext,
  ): Promise<RiskEvaluation> {
    return this.riskEngine.evaluate(action, context);
  }

  /**
   * Trigger the kill switch for a given scope.
   */
  async triggerKillSwitch(
    scope: KillSwitchScope,
    reason: string,
    triggeredBy: string,
  ): Promise<void> {
    await this.killSwitch.trigger(scope, reason, triggeredBy);
  }

  /**
   * Check if the kill switch is currently active for a given scope.
   */
  async isKillSwitchActive(scope: KillSwitchScope): Promise<boolean> {
    return this.killSwitch.isActive(scope);
  }

  /**
   * Reset the kill switch for a given scope.
   */
  async resetKillSwitch(
    scope: KillSwitchScope,
    resetBy: string,
  ): Promise<void> {
    await this.killSwitch.reset(scope, resetBy);
  }

  private buildConfig(): SecurityConfig {
    return {
      jwtPublicKeyPath: safeGet<string>(this.config, 'JWT_PUBLIC_KEY_PATH', './keys/jwt.pub'),
      jwtPrivateKeyPath: safeGet<string>(this.config, 'JWT_PRIVATE_KEY_PATH', './keys/jwt.key'),
      hmacChainSecret: safeGet<string>(this.config, 'HMAC_CHAIN_SECRET', 'dev-hmac-secret-change-me'),
      signingPrivateKey: safeGet<string>(this.config, 'SIGNING_PRIVATE_KEY', 'dev-signing-private-key'),
      signingPublicKey: safeGet<string>(this.config, 'SIGNING_PUBLIC_KEY', 'dev-signing-public-key'),
      adminUserId: safeGet<string>(this.config, 'ADMIN_USER_ID', 'admin'),
      velocityCircuitBreakerOrderCount: safeGet<number>(this.config, 'VELOCITY_CB_ORDER_COUNT', 10),
      velocityCircuitBreakerWindowSeconds: safeGet<number>(this.config, 'VELOCITY_CB_WINDOW_SECONDS', 60),
      errorRateCircuitBreakerConsecutiveRejectionCount: safeGet<number>(this.config, 'ERROR_RATE_CB_REJECTION_COUNT', 5),
      sessionDrawdownKillSwitchPercent: safeGet<number>(this.config, 'SESSION_DRAWDOWN_KILL_PERCENT', 10),
      portfolioNotionalLimit: safeGet<number>(this.config, 'PORTFOLIO_NOTIONAL_LIMIT', 1_000_000),
      positionLimitsPerInstrument: this.parseJsonEnv<Record<string, number>>('POSITION_LIMITS_PER_INSTRUMENT', {}),
      environment: safeGet<'development' | 'staging' | 'production'>(this.config, 'NODE_ENV', 'development') as 'development' | 'staging' | 'production',
    } as SecurityConfig;
  }

  private parseJsonEnv<T>(key: string, fallback: T): T {
    const raw = safeGet<string>(this.config, key);
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      this.logger.warn(`Failed to parse env ${key} as JSON, using default`);
      return fallback;
    }
  }
}
