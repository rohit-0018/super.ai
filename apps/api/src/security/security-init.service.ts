import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InputGuardService } from './input-guard.service';
import { OutputFilterService } from './output-filter.service';
import { RiskEngineService } from './risk-engine.service';
import { SecurityComplianceService } from './security-compliance.service';
import { MarketDataGuardService } from './market-data-guard.service';
import { SecurityAuditService } from './security-audit.service';
import { SecurityAlertService } from './security-alert.service';

/**
 * Orchestrates security module initialization with error resilience.
 * Each security service's onModuleInit can fail (e.g., missing config,
 * unavailable Redis) without crashing the entire application. This is
 * critical for the worker process which needs BullMQ but may not have
 * all security dependencies fully configured.
 */
@Injectable()
export class SecurityInitService implements OnModuleInit {
  private readonly logger = new Logger(SecurityInitService.name);

  constructor(
    private readonly alertService: SecurityAlertService,
    private readonly inputGuard: InputGuardService,
    private readonly outputFilter: OutputFilterService,
    private readonly riskEngine: RiskEngineService,
    private readonly compliance: SecurityComplianceService,
    private readonly marketDataGuard: MarketDataGuardService,
    private readonly audit: SecurityAuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    const services = [
      { name: 'SecurityAlertService', svc: this.alertService },
      { name: 'InputGuardService', svc: this.inputGuard },
      { name: 'OutputFilterService', svc: this.outputFilter },
      { name: 'RiskEngineService', svc: this.riskEngine },
      { name: 'SecurityComplianceService', svc: this.compliance },
      { name: 'MarketDataGuardService', svc: this.marketDataGuard },
      { name: 'SecurityAuditService', svc: this.audit },
    ];

    let ok = 0;
    let failed = 0;
    for (const { name, svc } of services) {
      try {
        if (svc && typeof (svc as any).safeInit === 'function') {
          await (svc as any).safeInit();
        }
        ok++;
      } catch (err: any) {
        failed++;
        this.logger.warn(`${name} init failed (non-fatal): ${err.message}`);
      }
    }
    this.logger.log(`Security module initialized: ${ok} ok, ${failed} degraded`);
  }
}
