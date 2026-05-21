import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { SnipeSessionService } from './snipe-session.service';
import { SnipeSellService } from './snipe-sell.service';
import { ParallelSnipeService } from './parallel-snipe.service';
import { UpsertSnipeConfigDto, StartSessionDto, UpsertGroupOverrideDto, BurstSnipeDto } from './snipe.dto';

@UseGuards(JwtAuthGuard)
@Controller('snipe')
export class SnipeController {
  constructor(
    private prisma: PrismaService,
    private snipeSession: SnipeSessionService,
    private snipeSell: SnipeSellService,
    private parallelSnipe: ParallelSnipeService,
  ) {}

  /** GET /api/snipe/config — return current snipe config + session status */
  @Get('config')
  async getConfig(@Req() req: any) {
    const userId: string = req.user.userId;
    const session = await this.snipeSession.sessionStatusWithBalance(userId);
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

  // ── Burst mode (parallel-wallet sniping) ──────────────────────────────────

  /**
   * POST /api/snipe/burst/start — decrypt all Solana wallets into hot
   * sessions so a subsequent /burst can fire instantly across them.
   * Idempotent; safe to call repeatedly. Sessions auto-expire after 1h.
   */
  @Post('burst/start')
  async startBurst(@Req() req: any) {
    const userId: string = req.user.userId;
    const wallets = await this.snipeSession.startBurstSessions(userId);
    return { ok: true, wallets };
  }

  /** DELETE /api/snipe/burst — stop all burst sessions (zero keys from memory). */
  @Delete('burst')
  stopBurst(@Req() req: any) {
    const userId: string = req.user.userId;
    this.snipeSession.stopBurstSessions(userId);
    return { ok: true };
  }

  /** GET /api/snipe/burst — burst session status with balances. */
  @Get('burst')
  getBurst(@Req() req: any) {
    const userId: string = req.user.userId;
    return this.snipeSession.burstStatus(userId);
  }

  /**
   * POST /api/snipe/burst — fire `buyAmountRaw` of SOL into `mint` from every
   * active burst session in parallel. Returns immediately with per-wallet
   * results; background monitor confirms each tx and emits WS updates.
   */
  @Post('burst')
  async fireBurst(@Req() req: any, @Body() dto: BurstSnipeDto) {
    const userId: string = req.user.userId;
    return this.parallelSnipe.burst({
      userId,
      mint: dto.mint,
      buyAmountRaw: dto.buyAmountRaw,
      maxSlippageBps: dto.maxSlippageBps,
      pauseWorkers: dto.pauseWorkers ?? true,
    });
  }

  /** POST /api/snipe/burst/resume — manually resume paused workers (escape hatch). */
  @Post('burst/resume')
  async resumeBurst() {
    await this.parallelSnipe.resumeQueues();
    return { ok: true };
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

  /**
   * GET /api/snipe/activity — unified buy/sell feed for the snipe history panel.
   *
   * Merges:
   *   - SnipeTrade rows (buys) — including their auto-sell rows when sellStatus is set.
   *   - Trade rows where the user manually sold a sniped mint (tokenIn matches a SnipeTrade.mint).
   *
   * Sorted desc by timestamp. Designed to power a DexScreener-style buy/sell list.
   */
  @Get('activity')
  async getActivity(@Req() req: any, @Query('limit') limit?: string) {
    const userId: string = req.user.userId;
    const take = Math.min(Number(limit ?? 100), 300);

    const snipeTrades = await this.prisma.snipeTrade.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take,
    });

    type ActivityItem = {
      kind: 'buy' | 'sell';
      source: 'snipe' | 'snipe_auto_sell' | 'manual_sell';
      id: string;
      mint: string;
      amountRaw: string | null;
      outAmount: string | null;
      txHash: string | null;
      status: string;
      errorMsg: string | null;
      sourceMsg: string | null;
      groupId: string | null;
      chain: string;
      attempts: number;
      createdAt: string;
      // sell-specific
      sellReason?: string | null;
      // for buys: keep auto-sell context so the UI can show it on the same row
      sellStatus?: string | null;
      sellTxHash?: string | null;
      // link sells back to the buy when known
      relatedBuyId?: string | null;
      // Buy-time snapshot (frozen at fill — survives token-price drift)
      priceAtBuyUsd?: number | null;
      mcapAtBuyUsd?: number | null;
      liquidityAtBuyUsd?: number | null;
      solPriceAtBuyUsd?: number | null;
      // Realized exit snapshot (set when sell confirms)
      proceedsSolAtSell?: number | null;
      proceedsUsdAtSell?: number | null;
      pnlUsdRealized?: number | null;
      pnlPctRealized?: number | null;
    };

    const items: ActivityItem[] = [];
    const mints = new Set<string>();

    for (const t of snipeTrades) {
      mints.add(t.mint);
      items.push({
        kind: 'buy',
        source: 'snipe',
        id: t.id,
        mint: t.mint,
        amountRaw: t.amountRaw,
        outAmount: t.outAmount,
        txHash: t.txHash,
        status: t.status,
        errorMsg: t.errorMsg,
        sourceMsg: t.sourceMsg,
        groupId: t.groupId,
        chain: t.chain,
        attempts: t.attempts ?? 1,
        createdAt: t.createdAt.toISOString(),
        sellStatus: t.sellStatus ?? null,
        sellTxHash: t.sellTxHash ?? null,
        sellReason: t.sellReason ?? null,
        priceAtBuyUsd: (t as any).priceAtBuyUsd ?? null,
        mcapAtBuyUsd: (t as any).mcapAtBuyUsd ?? null,
        liquidityAtBuyUsd: (t as any).liquidityAtBuyUsd ?? null,
        solPriceAtBuyUsd: (t as any).solPriceAtBuyUsd ?? null,
        proceedsSolAtSell: (t as any).proceedsSolAtSell ?? null,
        proceedsUsdAtSell: (t as any).proceedsUsdAtSell ?? null,
        pnlUsdRealized: (t as any).pnlUsdRealized ?? null,
        pnlPctRealized: (t as any).pnlPctRealized ?? null,
      });

      // Surface auto-sell as its own row when present, so it shows up red in the feed.
      if (t.sellStatus && t.sellStatus !== 'pending') {
        items.push({
          kind: 'sell',
          source: 'snipe_auto_sell',
          id: `${t.id}:sell`,
          mint: t.mint,
          amountRaw: t.outAmount,
          outAmount: (t as any).proceedsSolAtSell != null
            ? String(Math.round(((t as any).proceedsSolAtSell as number) * 1_000_000_000))
            : null,
          txHash: t.sellTxHash ?? null,
          status: t.sellStatus,
          errorMsg: null,
          sourceMsg: null,
          groupId: t.groupId,
          chain: t.chain,
          attempts: 1,
          createdAt: (t.sellCheckedAt ?? t.createdAt).toISOString(),
          sellReason: t.sellReason ?? null,
          relatedBuyId: t.id,
          priceAtBuyUsd: (t as any).priceAtBuyUsd ?? null,
          mcapAtBuyUsd: (t as any).mcapAtBuyUsd ?? null,
          solPriceAtBuyUsd: (t as any).solPriceAtBuyUsd ?? null,
          proceedsSolAtSell: (t as any).proceedsSolAtSell ?? null,
          proceedsUsdAtSell: (t as any).proceedsUsdAtSell ?? null,
          pnlUsdRealized: (t as any).pnlUsdRealized ?? null,
          pnlPctRealized: (t as any).pnlPctRealized ?? null,
        });
      }
    }

    // Manual sells (via /swap) where tokenIn was one of these mints.
    if (mints.size > 0) {
      const manualSells = await this.prisma.trade.findMany({
        where: {
          userId,
          tokenIn: { in: Array.from(mints) },
          side: 'sell',
        },
        orderBy: { createdAt: 'desc' },
        take,
      });

      for (const s of manualSells) {
        items.push({
          kind: 'sell',
          source: 'manual_sell',
          id: s.id,
          mint: s.tokenIn,
          amountRaw: s.amountIn,
          outAmount: s.amountOut,
          txHash: s.txHash ?? null,
          status: s.txHash ? 'confirmed' : 'submitted',
          errorMsg: null,
          sourceMsg: null,
          groupId: null,
          chain: s.chain,
          attempts: 1,
          createdAt: s.createdAt.toISOString(),
          sellReason: 'manual',
          relatedBuyId: null,
        });
      }
    }

    items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return items.slice(0, take);
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
