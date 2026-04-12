import { Injectable, Optional, Logger } from '@nestjs/common';
import { safeGet } from './security-config';
import { ConfigService } from '@nestjs/config';
import {
  InputGuard,
  PiiScrubber,
  InjectionDetector,
  ContextIntegrityService,
  SourceTrustClassifier,
  type SanitizedInput,
  type SecurityConfig,
  SourceTrust,
} from '@super-ai/security';
import { SecurityRedisService } from './security-redis.service';

/**
 * NestJS wrapper around InputGuard from @super-ai/security.
 * Sanitises user input before it reaches the LLM: scrubs PII,
 * detects prompt injection, verifies context integrity, and classifies source trust.
 */
@Injectable()
export class InputGuardService {
  private readonly logger = new Logger(InputGuardService.name);
  private inputGuard!: InputGuard;
  private contextIntegrity!: ContextIntegrityService;

  constructor(
    private readonly config: ConfigService,
    private readonly redis: SecurityRedisService,
  ) {}

  safeInit(): void {
    const securityConfig = this.buildConfig();

    const piiScrubber = new PiiScrubber();

    const injectionDetector = new InjectionDetector({
      injectionDetectionThresholdScore:
        securityConfig.injectionDetectionThresholdScore,
    });

    const nestLogger = this.logger;
    const loggerAdapter = {
      info: (msg: string, meta?: Record<string, unknown>) =>
        nestLogger.log(msg, meta),
      warn: (msg: string, meta?: Record<string, unknown>) =>
        nestLogger.warn(msg, meta),
      error: (msg: string, meta?: Record<string, unknown>) =>
        nestLogger.error(msg, meta),
    };

    this.contextIntegrity = new ContextIntegrityService(
      { hmacChainSecret: securityConfig.hmacChainSecret },
      loggerAdapter,
      this.redis,
    );

    const sourceClassifier = new SourceTrustClassifier({
      sourceTrustMap: {
        user: SourceTrust.INTERNAL,
        api: SourceTrust.INTERNAL,
        webhook: SourceTrust.VERIFIED_EXTERNAL,
        external: SourceTrust.UNVERIFIED_EXTERNAL,
      },
    });

    const systemPrompt =
      safeGet<string>(this.config, 'AI_SYSTEM_PROMPT') ||
      'You are a helpful AI trading assistant.';

    this.inputGuard = new InputGuard({
      piiScrubber,
      injectionDetector,
      contextIntegrity: this.contextIntegrity,
      sourceClassifier,
      logger: loggerAdapter,
      systemPrompt,
    });

    this.logger.log('InputGuardService initialized');
  }

  /**
   * Process raw user input through the full input security pipeline.
   */
  async process(
    text: string,
    source: string,
    sessionId: string,
    userId: string,
  ): Promise<SanitizedInput> {
    return this.inputGuard.process({ text, source, sessionId, userId });
  }

  /**
   * Seal the session context so any later tampering is detected.
   */
  async sealSession(sessionId: string): Promise<void> {
    const systemPrompt =
      safeGet<string>(this.config, 'AI_SYSTEM_PROMPT') ||
      'You are a helpful AI trading assistant.';
    await this.contextIntegrity.seal(systemPrompt, sessionId);
  }

  private buildConfig(): SecurityConfig {
    return {
      jwtPublicKeyPath: safeGet<string>(this.config, 'JWT_PUBLIC_KEY_PATH', './keys/jwt.pub'),
      jwtPrivateKeyPath: safeGet<string>(this.config, 'JWT_PRIVATE_KEY_PATH', './keys/jwt.key'),
      hmacChainSecret: safeGet<string>(this.config, 'HMAC_CHAIN_SECRET', 'dev-hmac-secret-change-me'),
      signingPrivateKey: safeGet<string>(this.config, 'SIGNING_PRIVATE_KEY', 'dev-signing-private-key'),
      signingPublicKey: safeGet<string>(this.config, 'SIGNING_PUBLIC_KEY', 'dev-signing-public-key'),
      adminUserId: safeGet<string>(this.config, 'ADMIN_USER_ID', 'admin'),
      injectionDetectionThresholdScore: safeGet<number>(this.config, 'INJECTION_THRESHOLD', 0.7),
      environment: safeGet<'development' | 'staging' | 'production'>(this.config, 'NODE_ENV', 'development') as 'development' | 'staging' | 'production',
    } as SecurityConfig;
  }
}
