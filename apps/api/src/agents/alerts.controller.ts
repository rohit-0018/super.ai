import { Body, Controller, DefaultValuePipe, Get, Param, ParseIntPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsEnum, IsNumber, IsString } from 'class-validator';
import { Chain } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';

class CreatePriceAlertDto {
  @IsString() token!: string;
  @IsEnum(Chain) chain!: Chain;
  @IsNumber() targetUsd!: number;
  @IsString() direction!: 'above' | 'below';
}

@UseGuards(JwtAuthGuard)
@Controller('alerts')
export class AlertsController {
  constructor(private prisma: PrismaService) {}

  @Get()
  async list(
    @Req() req: any,
    @Query('limit', new DefaultValuePipe(30), ParseIntPipe) limit: number,
    @Query('kind') kind?: string,
    @Query('severity') severity?: 'INFO' | 'WARN' | 'CRITICAL',
  ) {
    return this.prisma.alertEvent.findMany({
      where: {
        userId: req.user.userId,
        ...(kind ? { kind } : {}),
        ...(severity ? { severity } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 100),
    });
  }

  @Get('unread-count')
  async unreadCount(@Req() req: any) {
    const count = await this.prisma.alertEvent.count({
      where: { userId: req.user.userId, readAt: null },
    });
    return { count };
  }

  @Post('read-all')
  async markAllRead(@Req() req: any) {
    await this.prisma.alertEvent.updateMany({
      where: { userId: req.user.userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { ok: true };
  }

  @Patch(':id/read')
  async markRead(@Req() req: any, @Param('id') id: string) {
    await this.prisma.alertEvent.updateMany({
      where: { id, userId: req.user.userId },
      data: { readAt: new Date() },
    });
    return { ok: true };
  }

  @Get('briefings/latest')
  async latestBriefing(@Req() req: any) {
    const row = await this.prisma.alertEvent.findFirst({
      where: { userId: req.user.userId, kind: 'BRIEFING' },
      orderBy: { createdAt: 'desc' },
    });
    return row ?? null;
  }

  @Post('price-alerts')
  createPriceAlert(@Req() req: any, @Body() dto: CreatePriceAlertDto) {
    return (this.prisma as any).priceAlert.create({
      data: { userId: req.user.userId, token: dto.token, chain: dto.chain, targetUsd: dto.targetUsd, direction: dto.direction },
    });
  }

  @Get('price-alerts')
  listPriceAlerts(@Req() req: any) {
    return (this.prisma as any).priceAlert.findMany({
      where: { userId: req.user.userId, fired: false },
      orderBy: { createdAt: 'desc' },
    });
  }
}
