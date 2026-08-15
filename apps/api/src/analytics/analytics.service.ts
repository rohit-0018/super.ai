import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Trades read for series-derived stats (Sharpe, hold time, chart). */
const RECENT_WINDOW = 2_000;
/** Max points returned for the cumulative-P&L chart. */
const CHART_POINTS = 240;

/** Evenly samples a series down to at most `max` points, always keeping the last. */
function downsample(series: number[], max: number): number[] {
  if (series.length <= max) return series;
  const step = series.length / max;
  const out: number[] = [];
  for (let i = 0; i < max; i++) out.push(series[Math.floor(i * step)]);
  out[out.length - 1] = series[series.length - 1];
  return out;
}

@Injectable()
export class AnalyticsService {
  constructor(private prisma: PrismaService) {}

  /**
   * Headline stats are computed in the database; the per-trade series is read
   * from a bounded window.
   *
   * The previous version did `findMany({ where: { userId } })` with no `take`
   * and no `select` — it pulled every trade a user has ever made, including the
   * `convictionBreakdown` JSON blob, just to count wins and sum P&L. That grows
   * without limit and is the kind of query that is fine in dev and falls over
   * on a heavy account.
   *
   * Totals stay exact (aggregates run in Postgres over the full history). Only
   * the series-derived figures — Sharpe, average hold time, the chart — are
   * computed from the most recent RECENT_WINDOW trades.
   */
  async performance(userId: string) {
    const [agg, wins, losses, recentDesc] = await Promise.all([
      this.prisma.trade.aggregate({
        where: { userId },
        _count: { _all: true },
        _sum: { pnlUsd: true },
      }),
      this.prisma.trade.count({ where: { userId, pnlUsd: { gt: 0 } } }),
      this.prisma.trade.count({ where: { userId, pnlUsd: { lt: 0 } } }),
      this.prisma.trade.findMany({
        where: { userId },
        // Only the columns this method actually reads — avoids hauling JSON
        // blobs across the wire for a P&L sum.
        select: { pnlUsd: true, createdAt: true, tokenIn: true, tokenOut: true },
        orderBy: { createdAt: 'desc' },
        take: RECENT_WINDOW,
      }),
    ]);

    // Query was newest-first for the LIMIT; the maths below assumes chronological.
    const trades = recentDesc.reverse();

    const totalTrades = agg._count._all;
    const totalPnl = agg._sum.pnlUsd ?? 0;
    const winRate = totalTrades ? wins / totalTrades : 0;
    const avgPnl = totalTrades ? totalPnl / totalTrades : 0;

    const holdTimes: number[] = [];
    for (let i = 1; i < trades.length; i++) {
      if (trades[i].tokenIn === trades[i - 1].tokenOut) {
        holdTimes.push((trades[i].createdAt.getTime() - trades[i - 1].createdAt.getTime()) / 60_000);
      }
    }
    const avgHoldMinutes = holdTimes.length ? holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length : 0;

    const returns = trades.map((t) => t.pnlUsd ?? 0);
    const cumulativeSeries: number[] = [];
    let cum = 0;
    for (const r of returns) { cum += r; cumulativeSeries.push(cum); }
    // A chart cannot render more points than it has pixels; sending thousands
    // just inflates the payload and the client-side render cost.
    const cumulativeReturns = downsample(cumulativeSeries, CHART_POINTS);

    const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000);
    const weekTrades = trades.filter((t) => t.createdAt >= sevenDaysAgo);
    const weekPnl = weekTrades.reduce((s, t) => s + (t.pnlUsd ?? 0), 0);
    const weekWins = weekTrades.filter((t) => (t.pnlUsd ?? 0) > 0).length;

    return {
      totalTrades,
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

  /** Recent trades for replay. Bounded — the full history is not renderable. */
  async tradeReplay(userId: string, limit = 500) {
    const take = Math.min(Math.max(1, limit), 2_000);
    const rows = await this.prisma.trade.findMany({
      where: { userId },
      select: {
        id: true, side: true, chain: true, tokenIn: true, tokenOut: true,
        amountIn: true, amountOut: true, priceUsd: true, pnlUsd: true,
        mode: true, txHash: true, createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take,
    });
    return rows.reverse();
  }

  /** Tax export — basic ledger for now. */
  async taxExport(userId: string) {
    // Tax exports legitimately need the whole ledger, but only these columns —
    // selecting them explicitly keeps a full-history read from dragging JSON
    // blobs and embeddings along with it.
    const trades = await this.prisma.trade.findMany({
      where: { userId, mode: 'LIVE' },
      select: {
        createdAt: true, side: true, tokenIn: true, tokenOut: true,
        amountIn: true, amountOut: true, pnlUsd: true,
      },
      orderBy: { createdAt: 'asc' },
    });
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
