import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AnalyticsService } from './analytics.service';

@UseGuards(JwtAuthGuard)
@Controller('analytics')
export class AnalyticsController {
  constructor(private svc: AnalyticsService) {}
  @Get('performance') perf(@Req() req: any) { return this.svc.performance(req.user.userId); }
  @Get('replay') replay(@Req() req: any) { return this.svc.tradeReplay(req.user.userId); }
  @Get('tax') tax(@Req() req: any) { return this.svc.taxExport(req.user.userId); }
}
