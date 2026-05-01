import { Controller, Get, Param, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { TokenAnalysisService } from './token-analysis.service';

/**
 * GET /intel/:address?format=short|detailed
 * Single public endpoint for the intelligence dashboard.
 * short  — DexScreener + safety + playbooks, <2s
 * detailed — full pipeline with Claude AI (default)
 */
@Controller('intel')
export class IntelController {
  constructor(private readonly svc: TokenAnalysisService) {}

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get(':address')
  analyze(
    @Param('address') address: string,
    @Query('format') format?: string,
    @Query('force') force?: string,
  ) {
    const forceRefresh = force === 'true' || force === '1';
    return format === 'short'
      ? this.svc.analyzeShort(address)
      : this.svc.analyzeAddress(address, forceRefresh);
  }
}
