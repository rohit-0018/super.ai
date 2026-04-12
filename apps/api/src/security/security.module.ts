import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SecurityRedisService } from './security-redis.service';
import { InputGuardService } from './input-guard.service';
import { OutputFilterService, MARKET_DATA_PORT } from './output-filter.service';
import { RiskEngineService } from './risk-engine.service';
import { SecurityComplianceService } from './security-compliance.service';
import { MarketDataGuardService } from './market-data-guard.service';
import { SecurityAuditService } from './security-audit.service';
import { SecurityAlertService } from './security-alert.service';
import { SecurityInitService } from './security-init.service';

/**
 * Global NestJS module wrapping @super-ai/security.
 *
 * Provides injectable services for:
 * - Input sanitization (PII, injection, context integrity)
 * - Output filtering (allowlist, sanity, dedup)
 * - Risk engine (circuit breakers, kill switch, position limits, loss monitor)
 * - Compliance (wash trade, layering, short sell, trade reporting)
 * - Market data validation (consensus, anomaly detection)
 * - Audit logging (HMAC-chained, forensic replay)
 * - Security alerts (multi-channel)
 *
 * All services are @Global() so they can be injected anywhere without imports.
 *
 * To provide a MarketDataService for the output filter's sanity checker,
 * bind the MARKET_DATA_PORT token in a consuming module:
 *
 *   { provide: MARKET_DATA_PORT, useExisting: MarketDataService }
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    SecurityRedisService,
    SecurityAlertService,
    InputGuardService,
    OutputFilterService,
    RiskEngineService,
    SecurityComplianceService,
    MarketDataGuardService,
    SecurityAuditService,
    SecurityInitService,
    { provide: MARKET_DATA_PORT, useValue: null },
  ],
  exports: [
    SecurityRedisService,
    SecurityAlertService,
    InputGuardService,
    OutputFilterService,
    RiskEngineService,
    SecurityComplianceService,
    MarketDataGuardService,
    SecurityAuditService,
    MARKET_DATA_PORT,
  ],
})
export class SecurityModule {}
