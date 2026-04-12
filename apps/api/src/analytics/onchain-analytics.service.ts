import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class OnchainAnalyticsService {
  constructor(private prisma: PrismaService) {}

  async walletHistory(userId: string) {
    const trades = await this.prisma.trade.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { id: true, createdAt: true, tokenIn: true, tokenOut: true, amountIn: true, amountOut: true, pnlUsd: true, chain: true, txHash: true, mode: true },
    });
    const byToken = new Map<string, { count: number; totalPnl: number; lastTrade: Date }>();
    for (const t of trades) {
      const key = t.tokenOut.slice(0, 10);
      const prev = byToken.get(key) ?? { count: 0, totalPnl: 0, lastTrade: t.createdAt };
      prev.count++;
      prev.totalPnl += t.pnlUsd ?? 0;
      if (t.createdAt > prev.lastTrade) prev.lastTrade = t.createdAt;
      byToken.set(key, prev);
    }
    return {
      totalTrades: trades.length,
      uniqueTokens: byToken.size,
      tokenBreakdown: Array.from(byToken.entries())
        .map(([token, d]) => ({ token, ...d }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 20),
      recentTrades: trades.slice(0, 50),
    };
  }

  async holderDistribution(tokenAddress: string) {
    const cached = await this.prisma.tokenIntel.findFirst({ where: { address: tokenAddress } });
    if (!cached?.holderData) return { holders: [], source: 'no_data' };
    const data = cached.holderData as any;
    return {
      totalHolders: data.count ?? 0,
      topHolders: (data.top10 ?? data.top ?? []).slice(0, 20).map((h: any, i: number) => ({
        rank: i + 1,
        address: h.address ?? h.owner ?? `holder-${i}`,
        percentage: h.percentage ?? h.pct ?? 0,
        balance: h.balance ?? h.amount ?? 0,
      })),
      source: 'cached_from_scan',
    };
  }

  async whaleActivity(userId: string) {
    const trades = await this.prisma.trade.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    const largeThreshold = 1000;
    const whaleTrades = trades.filter((t) => Math.abs(t.pnlUsd ?? 0) > largeThreshold || Number(t.amountIn) > 1e8);
    return {
      totalLargeTrades: whaleTrades.length,
      recentWhale: whaleTrades.slice(0, 10).map((t) => ({
        id: t.id,
        token: t.tokenOut,
        amountIn: t.amountIn,
        pnlUsd: t.pnlUsd,
        createdAt: t.createdAt,
      })),
    };
  }

  async correlationMatrix(userId: string) {
    const trades = await this.prisma.trade.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
    const tokens = [...new Set(trades.map((t) => t.tokenOut.slice(0, 10)))].slice(0, 10);
    const returnsByToken = new Map<string, number[]>();
    for (const tok of tokens) {
      returnsByToken.set(tok, trades.filter((t) => t.tokenOut.slice(0, 10) === tok).map((t) => t.pnlUsd ?? 0));
    }
    const matrix: { a: string; b: string; corr: number }[] = [];
    for (let i = 0; i < tokens.length; i++) {
      for (let j = i + 1; j < tokens.length; j++) {
        const ra = returnsByToken.get(tokens[i])!;
        const rb = returnsByToken.get(tokens[j])!;
        matrix.push({ a: tokens[i], b: tokens[j], corr: pearson(ra, rb) });
      }
    }
    return { tokens, matrix };
  }
}

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const meanA = a.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const meanB = b.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA, db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  return den === 0 ? 0 : Math.round((num / den) * 100) / 100;
}
