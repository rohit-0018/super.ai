import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AnalyticsService } from './analytics.service';
import { OnchainAnalyticsService } from './onchain-analytics.service';
import { BacktestingService, BacktestParams } from './backtesting.service';
import { SignalAnalyticsService } from './signal-analytics.service';
import { PrismaService } from '../prisma/prisma.service';

@UseGuards(JwtAuthGuard)
@Controller('analytics')
export class AnalyticsController {
  constructor(
    private svc: AnalyticsService,
    private onchain: OnchainAnalyticsService,
    private backtest: BacktestingService,
    private signals: SignalAnalyticsService,
    private prisma: PrismaService,
  ) {}
  @Get('performance') perf(@Req() req: any) { return this.svc.performance(req.user.userId); }
  @Get('replay') replay(@Req() req: any) { return this.svc.tradeReplay(req.user.userId); }
  @Get('tax') tax(@Req() req: any) { return this.svc.taxExport(req.user.userId); }

  @Get('wallet-history') walletHistory(@Req() req: any) { return this.onchain.walletHistory(req.user.userId); }
  @Get('holder-distribution/:token') holderDistribution(@Param('token') token: string) { return this.onchain.holderDistribution(token); }
  @Get('whale-activity') whaleActivity(@Req() req: any) { return this.onchain.whaleActivity(req.user.userId); }
  @Get('correlation') correlation(@Req() req: any) { return this.onchain.correlationMatrix(req.user.userId); }

  @Post('backtest') backtest_(@Req() req: any, @Body() params: BacktestParams) { return this.backtest.run(req.user.userId, params); }

  // ── Signal / verdict analytics (no auth gate — global stats) ───────────────

  /** GET /analytics/signals/overview — hero stats: win rate, avg peak delta, best call */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('signals/overview')
  signalOverview(@Query('days') days?: string) {
    const since = days ? new Date(Date.now() - parseInt(days, 10) * 86_400_000) : undefined;
    return this.signals.getOverview(since);
  }

  /** GET /analytics/signals/by-tier — win rate breakdown by AI score band */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('signals/by-tier')
  signalByTier(@Query('days') days?: string) {
    const since = days ? new Date(Date.now() - parseInt(days, 10) * 86_400_000) : undefined;
    return this.signals.getByTier(since);
  }

  /** GET /analytics/signals/by-source — win rate breakdown by discovery source */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('signals/by-source')
  signalBySource(@Query('days') days?: string) {
    const since = days ? new Date(Date.now() - parseInt(days, 10) * 86_400_000) : undefined;
    return this.signals.getBySource(since);
  }

  /** GET /analytics/signals/exits — per-user exit reason breakdown */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('signals/exits')
  signalExits(@Req() req: any) {
    return this.signals.getExitBreakdown(req.user.userId);
  }

  /** GET /analytics/signals/trades — realized trade performance for current user */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('signals/trades')
  signalTrades(@Req() req: any, @Query('days') days?: string) {
    const since = days ? new Date(Date.now() - parseInt(days, 10) * 86_400_000) : undefined;
    return this.signals.getTradePerformance(req.user.userId, since);
  }

  // ── existing ────────────────────────────────────────────────────────────────

  @Get('insights')
  async insights(@Req() req: any) {
    const dna = await this.prisma.tradingDna.findUnique({ where: { userId: req.user.userId } });
    const user = await this.prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { emotionalState: true, riskProfile: true },
    });
    return {
      tradingDna: dna ?? null,
      emotionalState: user?.emotionalState ?? null,
      riskProfile: user?.riskProfile ?? null,
    };
  }
}
