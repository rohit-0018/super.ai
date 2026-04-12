import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AnalyticsService } from './analytics.service';
import { PrismaService } from '../prisma/prisma.service';

@UseGuards(JwtAuthGuard)
@Controller('analytics')
export class AnalyticsController {
  constructor(private svc: AnalyticsService, private prisma: PrismaService) {}
  @Get('performance') perf(@Req() req: any) { return this.svc.performance(req.user.userId); }
  @Get('replay') replay(@Req() req: any) { return this.svc.tradeReplay(req.user.userId); }
  @Get('tax') tax(@Req() req: any) { return this.svc.taxExport(req.user.userId); }

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
