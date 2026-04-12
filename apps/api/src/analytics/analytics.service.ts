import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AnalyticsService {
  constructor(private prisma: PrismaService) {}

  async performance(userId: string) {
    const trades = await this.prisma.trade.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
    const wins = trades.filter((t) => (t.pnlUsd ?? 0) > 0).length;
    const losses = trades.filter((t) => (t.pnlUsd ?? 0) < 0).length;
    const totalPnl = trades.reduce((s, t) => s + (t.pnlUsd ?? 0), 0);
    const winRate = trades.length ? wins / trades.length : 0;
    const avgPnl = trades.length ? totalPnl / trades.length : 0;

    const holdTimes: number[] = [];
    for (let i = 1; i < trades.length; i++) {
      if (trades[i].tokenIn === trades[i - 1].tokenOut) {
        holdTimes.push((trades[i].createdAt.getTime() - trades[i - 1].createdAt.getTime()) / 60_000);
      }
    }
    const avgHoldMinutes = holdTimes.length ? holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length : 0;

    const returns = trades.map((t) => t.pnlUsd ?? 0);
    const cumulativeReturns: number[] = [];
    let cum = 0;
    for (const r of returns) { cum += r; cumulativeReturns.push(cum); }

    const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000);
    const weekTrades = trades.filter((t) => t.createdAt >= sevenDaysAgo);
    const weekPnl = weekTrades.reduce((s, t) => s + (t.pnlUsd ?? 0), 0);
    const weekWins = weekTrades.filter((t) => (t.pnlUsd ?? 0) > 0).length;

    return {
      totalTrades: trades.length,
      wins,
      losses,
      winRate,
      totalPnl,
      avgPnl,
      sharpe: this.sharpe(returns),
      avgHoldMinutes: Math.round(avgHoldMinutes),
      cumulativeReturns,
      weekly: {
        trades: weekTrades.length,
        pnl: weekPnl,
        wins: weekWins,
        losses: weekTrades.length - weekWins,
        winRate: weekTrades.length ? weekWins / weekTrades.length : 0,
      },
    };
  }

  async tradeReplay(userId: string) {
    return this.prisma.trade.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  }

  /** Tax export — basic ledger for now. */
  async taxExport(userId: string) {
    const trades = await this.prisma.trade.findMany({ where: { userId, mode: 'LIVE' } });
    return trades.map((t) => ({
      date: t.createdAt.toISOString(),
      side: t.side, in: t.tokenIn, out: t.tokenOut, amountIn: t.amountIn, amountOut: t.amountOut, pnlUsd: t.pnlUsd,
    }));
  }

  private sharpe(returns: number[]): number {
    if (!returns.length) return 0;
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
    const std = Math.sqrt(variance);
    return std === 0 ? 0 : (mean / std) * Math.sqrt(252);
  }
}
