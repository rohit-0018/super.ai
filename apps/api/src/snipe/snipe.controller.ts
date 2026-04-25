import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { SnipeSessionService } from './snipe-session.service';
import { SnipeSellService } from './snipe-sell.service';
import { UpsertSnipeConfigDto, StartSessionDto, UpsertGroupOverrideDto } from './snipe.dto';

@UseGuards(JwtAuthGuard)
@Controller('snipe')
export class SnipeController {
  constructor(
    private prisma: PrismaService,
    private snipeSession: SnipeSessionService,
    private snipeSell: SnipeSellService,
  ) {}

  /** GET /api/snipe/config — return current snipe config + session status */
  @Get('config')
  async getConfig(@Req() req: any) {
    const userId: string = req.user.userId;
    const session = this.snipeSession.sessionStatus(userId);
    try {
      const config = await this.prisma.snipeConfig.findUnique({ where: { userId } });
      return { config, session };
    } catch {
      // Schema drift — new columns not yet applied. Run `make db-sync`.
      return { config: null, session };
    }
  }

  /** PUT /api/snipe/config — create or replace snipe config */
  @Put('config')
  async upsertConfig(@Req() req: any, @Body() dto: UpsertSnipeConfigDto) {
    const userId: string = req.user.userId;

    const sellFields = {
      sellEnabled:     dto.sellEnabled,
      sellMode:        dto.sellMode as any,
      takeProfitPct:   dto.takeProfitPct   ?? null,
      stopLossPct:     dto.stopLossPct     ?? null,
      trailingStopPct: dto.trailingStopPct ?? null,
      exitAfterMs:     dto.exitAfterMs     ?? null,
      partialExitPct:  dto.partialExitPct  ?? null,
    };

    const buyFields = {
      enabled:        dto.enabled,
      chain:          dto.chain as any,
      walletId:       dto.walletId,
      buyAmountRaw:   dto.buyAmountRaw,
      maxSlippageBps: dto.maxSlippageBps,
      groupIds:       dto.groupIds,
      skipSafety:     dto.skipSafety,
      dedupeWindowMs: dto.dedupeWindowMs,
      notifyOnBuy:    dto.notifyOnBuy,
      matchPattern:   dto.matchPattern ?? null,
    };

    const config = await this.prisma.snipeConfig.upsert({
      where: { userId },
      update: { ...buyFields, ...sellFields },
      create: { userId, ...buyFields, ...sellFields },
    });

    // Invalidate group cache so new groupIds take effect immediately
    this.snipeSession.invalidateGroupCache();
    return config;
  }

  /** POST /api/snipe/session/start — decrypt wallet key into hot session */
  @Post('session/start')
  async startSession(@Req() req: any, @Body() dto: StartSessionDto) {
    const userId: string = req.user.userId;
    const result = await this.snipeSession.startSession(userId, dto.walletId);
    return { ok: true, ...result };
  }

  /** DELETE /api/snipe/session — clear hot session (key zeroed from memory) */
  @Delete('session')
  stopSession(@Req() req: any) {
    const userId: string = req.user.userId;
    this.snipeSession.stopSession(userId);
    return { ok: true };
  }

  /** GET /api/snipe/session — session status */
  @Get('session')
  getSession(@Req() req: any) {
    const userId: string = req.user.userId;
    return this.snipeSession.sessionStatus(userId);
  }

  /** GET /api/snipe/history — recent snipe trades */
  @Get('history')
  async getHistory(@Req() req: any, @Query('limit') limit?: string) {
    const userId: string = req.user.userId;
    const take = Math.min(Number(limit ?? 50), 200);
    return this.prisma.snipeTrade.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  /** POST /api/snipe/history/:id/sell — manually trigger sell for a trade */
  @Post('history/:id/sell')
  async manualSell(@Req() req: any, @Param('id') tradeId: string) {
    const userId: string = req.user.userId;
    return this.snipeSell.manualSell(userId, tradeId);
  }

  // ── Group overrides ──

  /** GET /api/snipe/groups — list user's per-group overrides */
  @Get('groups')
  async listGroupOverrides(@Req() req: any) {
    const userId: string = req.user.userId;
    return this.prisma.snipeGroupOverride.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
    });
  }

  /** PUT /api/snipe/groups/:groupId — upsert a group override */
  @Put('groups/:groupId')
  async upsertGroupOverride(
    @Req() req: any,
    @Param('groupId') groupId: string,
    @Body() dto: UpsertGroupOverrideDto,
  ) {
    const userId: string = req.user.userId;
    const data = {
      groupTitle:     dto.groupTitle,
      enabled:        dto.enabled,
      buyAmountRaw:   dto.buyAmountRaw   ?? null,
      maxSlippageBps: dto.maxSlippageBps ?? null,
      sellMode:       (dto.sellMode as any) ?? null,
      takeProfitPct:  dto.takeProfitPct  ?? null,
      stopLossPct:    dto.stopLossPct    ?? null,
      trailingStopPct: dto.trailingStopPct ?? null,
      exitAfterMs:    dto.exitAfterMs    ?? null,
      matchPattern:   dto.matchPattern   ?? null,
    };
    return this.prisma.snipeGroupOverride.upsert({
      where: { userId_groupId: { userId, groupId } },
      update: data,
      create: { userId, groupId, ...data },
    });
  }

  /** DELETE /api/snipe/groups/:groupId — remove a group override */
  @Delete('groups/:groupId')
  async deleteGroupOverride(@Req() req: any, @Param('groupId') groupId: string) {
    const userId: string = req.user.userId;
    await this.prisma.snipeGroupOverride.deleteMany({ where: { userId, groupId } });
    return { ok: true };
  }
}
