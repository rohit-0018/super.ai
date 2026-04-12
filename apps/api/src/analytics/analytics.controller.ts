import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AnalyticsService } from './analytics.service';
import { OnchainAnalyticsService } from './onchain-analytics.service';
import { BacktestingService, BacktestParams } from './backtesting.service';
import { PrismaService } from '../prisma/prisma.service';

@UseGuards(JwtAuthGuard)
@Controller('analytics')
export class AnalyticsController {
  constructor(private svc: AnalyticsService, private onchain: OnchainAnalyticsService, private backtest: BacktestingService, private prisma: PrismaService) {}
  @Get('performance') perf(@Req() req: any) { return this.svc.performance(req.user.userId); }
  @Get('replay') replay(@Req() req: any) { return this.svc.tradeReplay(req.user.userId); }
  @Get('tax') tax(@Req() req: any) { return this.svc.taxExport(req.user.userId); }

  @Get('wallet-history') walletHistory(@Req() req: any) { return this.onchain.walletHistory(req.user.userId); }
  @Get('holder-distribution/:token') holderDistribution(@Param('token') token: string) { return this.onchain.holderDistribution(token); }
  @Get('whale-activity') whaleActivity(@Req() req: any) { return this.onchain.whaleActivity(req.user.userId); }
  @Get('correlation') correlation(@Req() req: any) { return this.onchain.correlationMatrix(req.user.userId); }

  @Post('backtest') backtest_(@Req() req: any, @Body() params: BacktestParams) { return this.backtest.run(req.user.userId, params); }

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
