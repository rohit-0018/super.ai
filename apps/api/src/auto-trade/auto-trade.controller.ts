import {
  Body, Controller, Get, NotFoundException, Param, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AutoTradeService } from './auto-trade.service';

class AutoStartDto {
  @IsOptional() @IsString() autoProfile?: string;
  @IsOptional() @IsInt() @Min(0) @Max(100) autoMinScore?: number;
  @IsOptional() @IsNumber() @Min(10) @Max(100_000) positionSizeUsd?: number;
  @IsOptional() @IsInt() @Min(1) @Max(100) maxConcurrent?: number;
  @IsOptional() @IsInt() @Min(0) @Max(1440) cooldownMinutes?: number;
  @IsOptional() @IsNumber() takeProfit1Pct?: number;
  @IsOptional() @IsNumber() takeProfit2Pct?: number;
  @IsOptional() @IsNumber() stopLossPct?: number;
  @IsOptional() @IsInt() @Min(1) maxHoldMinutes?: number;
}

class ManualOpenDto {
  @IsString() tokenAddress!: string;
  @IsOptional() @IsString() symbol?: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() profileKey?: string;
  @IsNumber() entryPriceUsd!: number;
  @IsNumber() @Min(10) sizeUsd!: number;
}

class CloseDto {
  @IsOptional() @IsNumber() exitPriceUsd?: number;
}

@UseGuards(JwtAuthGuard)
@Controller('auto-trade')
export class AutoTradeController {
  constructor(private readonly svc: AutoTradeService) {}

  // ── Portfolio ────────────────────────────────────────────────────────

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('portfolio')
  async getPortfolio(@Req() req: any) {
    return this.svc.getOrCreatePortfolio(req.user.userId);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('auto/start')
  async startAuto(@Req() req: any, @Body() dto: AutoStartDto) {
    return this.svc.updatePortfolioSettings(req.user.userId, {
      autoEnabled: true,
      ...dto,
    } as any);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('auto/stop')
  async stopAuto(@Req() req: any) {
    return this.svc.updatePortfolioSettings(req.user.userId, { autoEnabled: false } as any);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('settings')
  async updateSettings(@Req() req: any, @Body() dto: AutoStartDto) {
    return this.svc.updatePortfolioSettings(req.user.userId, dto as any);
  }

  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('reset')
  async resetPortfolio(@Req() req: any) {
    return this.svc.reset(req.user.userId);
  }

  // ── Positions ────────────────────────────────────────────────────────

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('positions')
  async getPositions(@Req() req: any) {
    return this.svc.listOpenPositions(req.user.userId);
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('trades')
  async getTrades(@Req() req: any, @Query('take') take?: string) {
    const n = take ? Math.max(1, Math.min(500, parseInt(take, 10))) : 100;
    return this.svc.listRecentTrades(req.user.userId, n);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('positions/open')
  async openManual(@Req() req: any, @Body() dto: ManualOpenDto) {
    return this.svc.openPosition({
      userId:         req.user.userId,
      tokenAddress:   dto.tokenAddress,
      symbol:         dto.symbol ?? null,
      name:           dto.name ?? null,
      profileKey:     dto.profileKey ?? 'meme_hunter',
      source:         'manual',
      entryPriceUsd:  dto.entryPriceUsd,
      sizeUsd:        dto.sizeUsd,
      scoreAtEntry:   0,
      verdictAtEntry: 'MANUAL',
    });
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('positions/:id/close')
  async closeManual(@Req() req: any, @Param('id') id: string, @Body() dto: CloseDto) {
    const open = await this.svc.listOpenPositions(req.user.userId);
    const pos = open.find((p) => p.id === id);
    if (!pos) throw new NotFoundException('Position not found');
    await this.svc.closePosition(id, {
      reason: 'MANUAL',
      exitPriceUsd: dto.exitPriceUsd ?? pos.currentPriceUsd,
    });
    return { ok: true };
  }
}
