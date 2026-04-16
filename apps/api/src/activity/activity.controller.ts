import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ActivityService, ActivityFilters } from './activity.service';
import { Chain } from '@prisma/client';

@UseGuards(JwtAuthGuard)
@Controller('activity')
export class ActivityController {
  constructor(private activity: ActivityService) {}

  @Get()
  list(
    @Req() req: any,
    @Query('source') source?: string,
    @Query('status') status?: string,
    @Query('side') side?: 'buy' | 'sell',
    @Query('chain') chain?: Chain,
    @Query('kind') kind?: 'ORDER' | 'TRADE',
    @Query('mode') mode?: 'LIVE' | 'PAPER',
    @Query('search') search?: string,
    @Query('since') since?: string,
    @Query('until') until?: string,
    @Query('limit') limit?: string,
  ) {
    const filters: ActivityFilters = {
      source: source || undefined,
      status: status || undefined,
      side: side || undefined,
      chain: chain || undefined,
      kind: kind || undefined,
      mode: mode || undefined,
      search: search || undefined,
      since: since ? new Date(since) : undefined,
      until: until ? new Date(until) : undefined,
      limit: limit ? Math.max(1, parseInt(limit, 10)) : undefined,
    };
    return this.activity.list(req.user.userId, filters);
  }

  @Get('stats')
  stats(@Req() req: any) {
    return this.activity.stats(req.user.userId);
  }
}
