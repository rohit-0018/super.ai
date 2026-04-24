import { Injectable, Logger } from '@nestjs/common';
import { ApprovalStatus, Prisma, StrategyPerformance } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export interface StrategyAggregates {
  sampleCount: number;
  sampleCountAllTime: number;
  wins: number;
  losses: number;
  totalPnlUsd: number;
  totalPnlUsdAllTime: number;
  avgPnlUsd: number;
  stdevPnlUsd: number;
  maxDrawdownUsd: number;
  avgHoldMinutes: number;
  approvalsAccepted: number;
  approvalsRejected: number;
  approvalAcceptRate: number | null;
  lastTradeAt: Date | null;
}

@Injectable()
export class StrategyPerformanceService {
  private readonly logger = new Logger(StrategyPerformanceService.name);

  constructor(private prisma: PrismaService) {}

  async computeFor(strategyId: string): Promise<StrategyAggregates> {
    const since = new Date(Date.now() - THIRTY_DAYS_MS);

    const [windowTrades, allTimeAgg, approvalAgg] = await Promise.all([
      this.prisma.trade.findMany({
        where: { strategyId, createdAt: { gte: since } },
        orderBy: { createdAt: 'asc' },
        select: { pnlUsd: true, createdAt: true },
      }),
      this.prisma.trade.aggregate({
        where: { strategyId },
        _count: { _all: true },
        _sum: { pnlUsd: true },
      }),
      this.prisma.approvalRequest.groupBy({
        by: ['status'],
        where: { strategyId, createdAt: { gte: since } },
        _count: { _all: true },
      }),
    ]);

    let wins = 0;
    let losses = 0;
    let totalPnl = 0;
    const pnls: number[] = [];
    for (const t of windowTrades) {
      const p = t.pnlUsd ?? 0;
      if (p > 0) wins += 1;
      else if (p < 0) losses += 1;
      totalPnl += p;
      pnls.push(p);
    }
    const sampleCount = windowTrades.length;
    const avgPnlUsd = sampleCount > 0 ? totalPnl / sampleCount : 0;
    const stdevPnlUsd = this.stdev(pnls, avgPnlUsd);
    const maxDrawdownUsd = this.maxDrawdown(pnls);
    const avgHoldMinutes = this.avgMinutesBetween(windowTrades.map((t) => t.createdAt));

    let accepted = 0;
    let rejected = 0;
    for (const row of approvalAgg) {
      const n = row._count._all ?? 0;
      if (row.status === ApprovalStatus.APPROVED) accepted += n;
      else if (row.status === ApprovalStatus.REJECTED || row.status === ApprovalStatus.EXPIRED) rejected += n;
    }
    const denom = accepted + rejected;
    const approvalAcceptRate = denom >= 3 ? accepted / denom : null;

    return {
      sampleCount,
      sampleCountAllTime: allTimeAgg._count._all ?? 0,
      wins,
      losses,
      totalPnlUsd: totalPnl,
      totalPnlUsdAllTime: allTimeAgg._sum.pnlUsd ?? 0,
      avgPnlUsd,
      stdevPnlUsd,
      maxDrawdownUsd,
      avgHoldMinutes,
      approvalsAccepted: accepted,
      approvalsRejected: rejected,
      approvalAcceptRate,
      lastTradeAt: windowTrades.length ? windowTrades[windowTrades.length - 1].createdAt : null,
    };
  }

  async upsertFor(strategyId: string, userId: string): Promise<StrategyPerformance> {
    const agg = await this.computeFor(strategyId);
    return this.prisma.strategyPerformance.upsert({
      where: { strategyId },
      create: {
        strategyId,
        userId,
        ...agg,
      },
      update: {
        ...agg,
        lastComputedAt: new Date(),
      } as Prisma.StrategyPerformanceUpdateInput,
    });
  }

  async getForUser(userId: string, strategyId: string): Promise<(StrategyPerformance & { strategyName: string; score: number | null; scoreBreakdown: Prisma.JsonValue | null }) | null> {
    const strategy = await this.prisma.userStrategy.findUnique({
      where: { id: strategyId },
      include: { performance: true },
    });
    if (!strategy || strategy.userId !== userId) return null;
    const perf = strategy.performance ?? (await this.upsertFor(strategyId, userId));
    return {
      ...perf,
      strategyName: strategy.name,
      score: strategy.score,
      scoreBreakdown: strategy.scoreBreakdown,
    };
  }

  // Single-pass max drawdown over the cumulative PnL series. Returns a
  // positive number (0 = no drawdown). Deterministic given input order.
  private maxDrawdown(pnls: number[]): number {
    let peak = 0;
    let cum = 0;
    let maxDd = 0;
    for (const p of pnls) {
      cum += p;
      if (cum > peak) peak = cum;
      const dd = peak - cum;
      if (dd > maxDd) maxDd = dd;
    }
    return maxDd;
  }

  private stdev(values: number[], mean: number): number {
    if (values.length === 0) return 0;
    let sum = 0;
    for (const v of values) sum += (v - mean) * (v - mean);
    return Math.sqrt(sum / values.length);
  }

  // Placeholder until Trade has a close-timestamp column. Minutes between
  // consecutive trades; 0 when fewer than 2 trades.
  private avgMinutesBetween(ts: Date[]): number {
    if (ts.length < 2) return 0;
    let total = 0;
    for (let i = 1; i < ts.length; i++) total += (ts[i].getTime() - ts[i - 1].getTime()) / 60_000;
    return total / (ts.length - 1);
  }
}
