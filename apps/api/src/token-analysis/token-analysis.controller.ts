import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsNotEmpty, IsString } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { TokenAnalysisService } from './token-analysis.service';
import type { Chain } from './token-analysis.types';

class AnalyzeByAddressDto {
  @IsString()
  @IsNotEmpty()
  address!: string;
}

@Controller('token-analysis')
export class TokenAnalysisController {
  constructor(private svc: TokenAnalysisService) {}

  /**
   * GET /token-analysis/:chain/:address
   * Public — used by landing page token previews and external integrations.
   * Throttled at 20/min per IP (tighter than global 120 because it calls Claude).
   */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get(':chain/:address')
  analyze(@Param('chain') chain: string, @Param('address') address: string) {
    return this.svc.analyze(chain.toUpperCase() as Chain, address);
  }

  /**
   * POST /token-analysis/analyze
   * Auto-detect chain from address format — no chain param needed.
   * Requires JWT (calls Claude on cache miss — cost protection).
   * Throttled at 10/min per user.
   */
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('analyze')
  analyzeAddress(@Body() dto: AnalyzeByAddressDto) {
    return this.svc.analyzeAddress(dto.address);
  }
}
