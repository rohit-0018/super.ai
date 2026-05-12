import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { AutoExitReason, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../ws/realtime.gateway';
import { getProfile } from '../token-analysis/profile.config';
import type { TradingProfile } from '../token-analysis/profile.config';
import type {
  CloseDecision,
  OpenAutoPositionInput,
  AutoPortfolio,
  AutoPosition,
} from './auto-trade.types';

const PROFILE_FALLBACK: TradingProfile = 'meme_hunter';

@Injectable()
export class AutoTradeService {
  private readonly logger = new Logger(AutoTradeService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly realtime: RealtimeGateway,
  ) {}

  // ── Portfolio ──────────────────────────────────────────────────────────

  /** Get or lazily create the user's auto-trade portfolio with defaults. */
  async getOrCreatePortfolio(userId: string): Promise<AutoPortfolio> {
    const existing = await this.prisma.autoPortfolio.findUnique({ where: { userId } });
    if (existing) return existing;
    return this.prisma.autoPortfolio.create({ data: { userId } });
  }

  async updatePortfolioSettings(userId: string, patch: Partial<AutoPortfolio>): Promise<AutoPortfolio> {
    // Soft-cap a few sanity values so the auto-picker can't be configured
    // into runaway-cost behaviour.
    const safe: Record<string, unknown> = {};
    if (patch.autoEnabled !== undefined)     safe.autoEnabled     = patch.autoEnabled;
    if (patch.autoProfile)                   safe.autoProfile     = patch.autoProfile;
    if (patch.autoMinScore !== undefined)    safe.autoMinScore    = Math.max(0, Math.min(100, patch.autoMinScore));
    if (patch.positionSizeUsd !== undefined) safe.positionSizeUsd = Math.max(10, Math.min(100_000, patch.positionSizeUsd));
    if (patch.maxConcurrent !== undefined)   safe.maxConcurrent   = Math.max(1, Math.min(100, patch.maxConcurrent));
    if (patch.cooldownMinutes !== undefined) safe.cooldownMinutes = Math.max(0, Math.min(1440, patch.cooldownMinutes));
    if (patch.takeProfit1Pct !== undefined)  safe.takeProfit1Pct  = patch.takeProfit1Pct;
    if (patch.takeProfit2Pct !== undefined)  safe.takeProfit2Pct  = patch.takeProfit2Pct;
    if (patch.stopLossPct !== undefined)     safe.stopLossPct     = patch.stopLossPct;
    if (patch.maxHoldMinutes !== undefined)  safe.maxHoldMinutes  = patch.maxHoldMinutes;

    const portfolio = await this.prisma.autoPortfolio.upsert({
      where: { userId },
      create: { ...(safe as Prisma.AutoPortfolioUncheckedCreateInput), userId },
      update: safe as Prisma.AutoPortfolioUncheckedUpdateInput,
    });
    this.emitPortfolio(portfolio);
    return portfolio;
  }

  /** Reset to starting balance + clear all positions/trades. Destructive. */
  async reset(userId: string): Promise<AutoPortfolio> {
    await this.prisma.$transaction([
      this.prisma.autoPosition.deleteMany({ where: { userId } }),
      this.prisma.autoTrade.deleteMany({ where: { userId } }),
    ]);
    const portfolio = await this.prisma.autoPortfolio.upsert({
      where: { userId },
      create: { userId, resetAt: new Date(), autoEnabled: false },
      update: {
        autoEnabled:       false,
        currentBalanceUsd: { set: 100_000 },
        realizedPnlUsd:    0,
        totalTrades:       0,
        winCount:          0,
        lossCount:         0,
        resetAt:           new Date(),
        lastTradeAt:       null,
      },
    });
    this.emitPortfolio(portfolio);
    return portfolio;
  }

  // ── Positions ──────────────────────────────────────────────────────────

  /**
   * Open an auto-trade position. Atomic via $transaction — either both the
   * position row + balance decrement land, or neither does. The unique
   * constraint on (userId, tokenAddress) prevents duplicate concurrent
   * picker ticks. P2002 is caught and we return the existing row.
   */
  async openPosition(input: OpenAutoPositionInput): Promise<AutoPosition | null> {
    if (input.entryPriceUsd <= 0 || input.sizeUsd <= 0) return null;

    const portfolio = await this.getOrCreatePortfolio(input.userId);

    // Balance guard — never let the picker go into negative virtual cash.
    if (portfolio.currentBalanceUsd < input.sizeUsd) {
      this.logger.warn(`Skip open user=${input.userId} ${input.symbol ?? input.tokenAddress.slice(0, 6)}: balance $${portfolio.currentBalanceUsd.toFixed(0)} < size $${input.sizeUsd}`);
      return null;
    }

    const profile = this.resolveProfile(input.profileKey);
    const strat = profile.strategy;

    const t1Mult = input.takeProfit1Pct != null ? 1 + input.takeProfit1Pct / 100
                  : portfolio.takeProfit1Pct != null ? 1 + portfolio.takeProfit1Pct / 100
                  : strat.targets[0] ?? 1.5;
    const t2Mult = input.takeProfit2Pct != null ? 1 + input.takeProfit2Pct / 100
                  : portfolio.takeProfit2Pct != null ? 1 + portfolio.takeProfit2Pct / 100
                  : strat.targets[1] ?? strat.targets[0] ?? 2.5;
    const slPct  = input.stopLossPct ?? portfolio.stopLossPct ?? strat.stopLossPct;
    const maxHoldMs = input.maxHoldMinutes != null
      ? input.maxHoldMinutes * 60_000
      : portfolio.maxHoldMinutes != null
      ? portfolio.maxHoldMinutes * 60_000
      : strat.maxHoldMs;

    const takeProfit1PriceUsd = input.entryPriceUsd * t1Mult;
    const takeProfit2PriceUsd = input.entryPriceUsd * t2Mult;
    const stopLossPriceUsd    = input.entryPriceUsd * (1 - slPct / 100);
    const tokenAmount         = input.sizeUsd / input.entryPriceUsd;
    const breakdownJson: Prisma.InputJsonValue | typeof Prisma.DbNull =
      input.scoreBreakdown ? (input.scoreBreakdown as Prisma.InputJsonValue) : Prisma.DbNull;

    try {
      const [position, freshPortfolio] = await this.prisma.$transaction([
        this.prisma.autoPosition.create({
          data: {
            userId:              input.userId,
            tokenAddress:        input.tokenAddress,
            symbol:              input.symbol ?? null,
            name:                input.name ?? null,
            chain:               (input.chain ?? 'SOLANA') as any,
            profileKey:          input.profileKey,
            source:              input.source ?? 'auto_picker',
            entryPriceUsd:       input.entryPriceUsd,
            sizeUsd:             input.sizeUsd,
            tokenAmount,
            takeProfit1PriceUsd,
            takeProfit2PriceUsd,
            stopLossPriceUsd,
            maxHoldMs,
            currentPriceUsd:     input.entryPriceUsd,
            unrealizedPnlUsd:    0,
            unrealizedPnlPct:    0,
            scoreAtEntry:        input.scoreAtEntry,
            verdictAtEntry:      input.verdictAtEntry,
            scoreBreakdownJson:  breakdownJson,
          },
        }),
        this.prisma.autoPortfolio.update({
          where: { userId: input.userId },
          data:  { currentBalanceUsd: { decrement: input.sizeUsd } },
        }),
      ]);

      this.realtime?.emitToUser(input.userId, 'auto_position_opened', position);
      this.emitPortfolio(freshPortfolio);
      return position;
    } catch (e: any) {
      // P2002 = unique constraint violation. Concurrent tick won the race;
      // return the existing row so the caller can no-op cleanly.
      if (e?.code === 'P2002') {
        return this.prisma.autoPosition.findFirst({
          where: { userId: input.userId, tokenAddress: input.tokenAddress },
        });
      }
      throw e;
    }
  }

  /**
   * Close a position and write the trade history row. PnL booked.
   * Emits `auto_position_closed` with `wasOpenId` so the UI can animate the
   * disappearing Active row directly into the Closed table — instead of
   * the row just vanishing and a new one appearing elsewhere with no link.
   */
  async closePosition(id: string, decision: CloseDecision): Promise<void> {
    const position = await this.prisma.autoPosition.findUnique({ where: { id } });
    if (!position) throw new NotFoundException(`Auto position ${id} not found`);

    const pnlUsd = (decision.exitPriceUsd - position.entryPriceUsd) * position.tokenAmount;
    const pnlPct = (decision.exitPriceUsd / position.entryPriceUsd - 1) * 100;
    const holdMs = Date.now() - position.openedAt.getTime();
    const isWin = pnlUsd > 0;
    const breakdownJson: Prisma.InputJsonValue | typeof Prisma.DbNull =
      position.scoreBreakdownJson ? (position.scoreBreakdownJson as Prisma.InputJsonValue) : Prisma.DbNull;

    const [trade, , freshPortfolio] = await this.prisma.$transaction([
      this.prisma.autoTrade.create({
        data: {
          userId:       position.userId,
          tokenAddress: position.tokenAddress,
          symbol:       position.symbol,
          name:         position.name,
          chain:        position.chain,
          profileKey:   position.profileKey,
          source:       position.source,
          openedAt:     position.openedAt,
          holdMs,
          entryPriceUsd: position.entryPriceUsd,
          exitPriceUsd:  decision.exitPriceUsd,
          sizeUsd:       position.sizeUsd,
          tokenAmount:   position.tokenAmount,
          pnlUsd,
          pnlPct,
          exitReason:           decision.reason as AutoExitReason,
          scoreAtEntry:         position.scoreAtEntry,
          verdictAtEntry:       position.verdictAtEntry,
          scoreBreakdownJson:   breakdownJson,
        },
      }),
      this.prisma.autoPosition.delete({ where: { id } }),
      this.prisma.autoPortfolio.update({
        where: { userId: position.userId },
        data: {
          currentBalanceUsd: { increment: position.sizeUsd + pnlUsd },
          realizedPnlUsd:    { increment: pnlUsd },
          totalTrades:       { increment: 1 },
          winCount:          { increment: isWin ? 1 : 0 },
          lossCount:         { increment: isWin ? 0 : 1 },
          lastTradeAt:       new Date(),
        },
      }),
    ]);

    this.realtime?.emitToUser(position.userId, 'auto_position_closed', {
      trade,
      wasOpenId: position.id,
    });
    this.emitPortfolio(freshPortfolio);
  }

  /**
   * Recompute unrealized PnL for an open position given a fresh price and
   * decide whether any exit condition has fired. Caller acts on the
   * decision; we just compute, persist, and emit the update.
   */
  async updatePriceTick(position: AutoPosition, currentPriceUsd: number): Promise<CloseDecision | null> {
    if (currentPriceUsd <= 0) return null;
    const unrealizedPnlUsd = (currentPriceUsd - position.entryPriceUsd) * position.tokenAmount;
    const unrealizedPnlPct = (currentPriceUsd / position.entryPriceUsd - 1) * 100;

    const decision = this.decideExit(position, currentPriceUsd);

    if (!decision) {
      await this.prisma.autoPosition.update({
        where: { id: position.id },
        data:  { currentPriceUsd, unrealizedPnlUsd, unrealizedPnlPct },
      });
      this.realtime?.emitToUser(position.userId, 'auto_position_updated', {
        id: position.id,
        currentPriceUsd,
        unrealizedPnlUsd,
        unrealizedPnlPct,
      });
    }
    return decision;
  }

  /** TP2 > TP1 > stop-loss > max-hold timeout. */
  decideExit(position: AutoPosition, currentPriceUsd: number): CloseDecision | null {
    const elapsed = Date.now() - position.openedAt.getTime();
    if (currentPriceUsd >= position.takeProfit2PriceUsd) {
      return { reason: 'TP2', exitPriceUsd: position.takeProfit2PriceUsd };
    }
    if (currentPriceUsd >= position.takeProfit1PriceUsd) {
      return { reason: 'TP1', exitPriceUsd: position.takeProfit1PriceUsd };
    }
    if (currentPriceUsd <= position.stopLossPriceUsd) {
      return { reason: 'STOP_LOSS', exitPriceUsd: position.stopLossPriceUsd };
    }
    if (elapsed >= position.maxHoldMs) {
      return { reason: 'MAX_HOLD', exitPriceUsd: currentPriceUsd };
    }
    return null;
  }

  // ── Queries ────────────────────────────────────────────────────────────

  async listOpenPositions(userId: string): Promise<AutoPosition[]> {
    return this.prisma.autoPosition.findMany({
      where: { userId },
      orderBy: { openedAt: 'desc' },
      take: 100,
    });
  }

  async listRecentTrades(userId: string, take = 100) {
    return this.prisma.autoTrade.findMany({
      where: { userId },
      orderBy: { closedAt: 'desc' },
      take,
    });
  }

  // ── Internal helpers ───────────────────────────────────────────────────

  private resolveProfile(key: string) {
    try { return getProfile(key as TradingProfile); }
    catch { return getProfile(PROFILE_FALLBACK); }
  }

  private emitPortfolio(p: AutoPortfolio) {
    this.realtime?.emitToUser(p.userId, 'auto_portfolio_updated', {
      currentBalanceUsd: p.currentBalanceUsd,
      realizedPnlUsd:    p.realizedPnlUsd,
      totalTrades:       p.totalTrades,
      winCount:          p.winCount,
      lossCount:         p.lossCount,
      autoEnabled:       p.autoEnabled,
    });
  }
}
