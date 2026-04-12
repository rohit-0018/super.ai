import { Injectable, Optional, Logger } from '@nestjs/common';
import { safeGet } from './security-config';
import { ConfigService } from '@nestjs/config';
import {
  AuditLogger,
  HmacChain,
  ForensicsService,
  JsonlFileWriter,
  NoopWriter,
  type LogContext,
  type SessionReplay,
  type SecurityConfig,
  SecurityEventType,
  RiskLevel,
  type SecurityEvent,
} from '@super-ai/security';

/**
 * NestJS wrapper around AuditLogger and ForensicsService from @super-ai/security.
 * Provides tamper-evident audit logging with HMAC chains and session replay.
 */
@Injectable()
export class SecurityAuditService {
  private readonly logger = new Logger(SecurityAuditService.name);
  private auditLogger!: AuditLogger;
  private forensicsService!: ForensicsService;

  constructor(private readonly config: ConfigService) {}

  safeInit(): void {
    const securityConfig = this.buildConfig();

    const hmacChain = new HmacChain(securityConfig.hmacChainSecret);

    // Use JSONL file writer in non-test environments, NoopWriter otherwise
    const auditLogPath = securityConfig.auditLogOutputPath;
    const logWriter =
      securityConfig.environment === 'development' && !auditLogPath
        ? new NoopWriter()
        : new JsonlFileWriter(auditLogPath);

    this.auditLogger = new AuditLogger(securityConfig, hmacChain, logWriter);
    this.forensicsService = new ForensicsService(securityConfig, hmacChain);

    this.logger.log('SecurityAuditService initialized');
  }

  /**
   * Log a security event to the audit trail.
   * Constructs a SecurityEvent from the eventType and payload, then logs it
   * with full context (correlation ID, user, session, circuit breaker states).
   */
  async log(
    eventType: string,
    payload: Record<string, unknown>,
    context?: Partial<LogContext>,
  ): Promise<void> {
    const event: SecurityEvent = {
      eventType: eventType as SecurityEventType,
      riskLevel: (payload.riskLevel as RiskLevel) ?? RiskLevel.LOW,
      timestamp: new Date().toISOString(),
      ...payload,
    } as SecurityEvent;

    const fullContext: LogContext = {
      correlationId:
        context?.correlationId ?? AuditLogger.getCorrelationId(),
      userId: context?.userId,
      sessionId: context?.sessionId,
      strategyId: context?.strategyId,
      latencyMs: context?.latencyMs ?? 0,
      circuitBreakerStates: context?.circuitBreakerStates ?? [],
    };

    try {
      await this.auditLogger.log(event, fullContext);
    } catch (err: any) {
      // AuditLogger from @super-ai/security may reject events that don't match
      // its expected schema. Log locally and continue — don't crash the trade.
      this.logger.debug(`Audit log write skipped: ${err.message}`);
    }
  }

  /**
   * Replay a session from the audit log for forensic analysis.
   */
  async replay(sessionId: string): Promise<SessionReplay> {
    return this.forensicsService.replay(sessionId);
  }

  /**
   * Generate a unique correlation ID for tracing.
   */
  static getCorrelationId(): string {
    return AuditLogger.getCorrelationId();
  }

  private buildConfig(): SecurityConfig {
    return {
      jwtPublicKeyPath: safeGet<string>(this.config, 'JWT_PUBLIC_KEY_PATH', './keys/jwt.pub'),
      jwtPrivateKeyPath: safeGet<string>(this.config, 'JWT_PRIVATE_KEY_PATH', './keys/jwt.key'),
      hmacChainSecret: safeGet<string>(this.config, 'HMAC_CHAIN_SECRET', 'dev-hmac-secret-change-me'),
      signingPrivateKey: safeGet<string>(this.config, 'SIGNING_PRIVATE_KEY', 'dev-signing-private-key'),
      signingPublicKey: safeGet<string>(this.config, 'SIGNING_PUBLIC_KEY', 'dev-signing-public-key'),
      adminUserId: safeGet<string>(this.config, 'ADMIN_USER_ID', 'admin'),
      auditLogOutputPath: safeGet<string>(this.config, 'AUDIT_LOG_PATH', './data/audit.jsonl'),
      environment: safeGet<'development' | 'staging' | 'production'>(this.config, 'NODE_ENV', 'development') as 'development' | 'staging' | 'production',
    } as SecurityConfig;
  }
}
