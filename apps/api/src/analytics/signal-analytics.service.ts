import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface SignalOverview {
  totalSignals:    number;
  strongBuys:      number;
  winRate:         number;  // % of captures that peaked ≥2x from entry
  avgPeakDelta:    number;  // average peak % gain across all captures
  avgScore:        number;  // average AI score across VerdictHistory
  rugRate:         number;  // % that ended as 'rugged'
  bestCall:        { symbol: string | null; peakDelta: number } | null;
  analyzedTokens:  number;  // distinct tokens with at least one verdict
  realizedPnl:     number;  // sum of Trade.realizedPnl for exited trades
  openPositions:   number;
}

export interface TierBreakdown {
  tier:        string;    // '60-69' | '70-79' | '80-89' | '90-100'
  count:       number;
  winRate:     number;
  avgPeakDelta: number;
  rugRate:     number;
}

export interface SourceBreakdown {
  source:      string;
  count:       number;
  winRate:     number;
  avgPeakDelta: number;
}

export interface TradePerformance {
  tradeId:         string;
  token:           string;
  side:            string;
  mode:            string;
  entryUsd:        number;
  exitUsd:         number | null;
  realizedPnl:     number | null;
  holdDurationSec: number | null;
  exitReason:      string | null;
  createdAt:       string;
  exitAt:          string | null;
}

@Injectable()
export class SignalAnalyticsService {
  private readonly logger = new Logger(SignalAnalyticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── overview ───────────────────────────────────────────────────────────────

  async getOverview(since?: Date): Promise<SignalOverview> {
    const dateFilter = since ? { capturedAt: { gte: since } } : {};

    const [snapshots, verdictCount, exitedTrades, openTrades] = await Promise.all([
      this.prisma.intelSnapshot.findMany({
        where: dateFilter,
        select: {
          symbol: true,
          pumpedHigh: true,
          marketCapUsdAtCapture: true,
          status: true,
          aiScore: true,
        },
      }),
      this.prisma.verdictHistory.groupBy({
        by: ['address'],
        _count: { address: true },
      }),
      this.prisma.trade.findMany({
        where: { side: 'buy', exitAt: { not: null } },
        select: { realizedPnl: true },
      }),
      this.prisma.trade.count({ where: { side: 'buy', exitAt: null } }),
    ]);

    // Compute peak delta pct from raw fields: (pumpedHigh - entryMcap) / entryMcap * 100
    const withDelta = snapshots.map((s) => {
      const entry   = s.marketCapUsdAtCapture ?? 0;
      const peak    = s.pumpedHigh ?? 0;
      const delta   = entry > 0 && peak > 0 ? ((peak - entry) / entry) * 100 : 0;
      return { ...s, peakDeltaPct: delta };
    });

    const total  = withDelta.length;
    const wins   = withDelta.filter((s) => s.peakDeltaPct >= 100).length; // ≥2x = 100% gain
    const rugs   = withDelta.filter((s) => s.status === 'rugged').length;
    const deltas = withDelta.map((s) => s.peakDeltaPct);
    const avgPeak = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
    const avgScore = withDelta.length
      ? withDelta.filter((s) => s.aiScore != null).reduce((a, s) => a + (s.aiScore ?? 0), 0) /
        (withDelta.filter((s) => s.aiScore != null).length || 1)
      : 0;

    const best = [...withDelta].sort((a, b) => b.peakDeltaPct - a.peakDeltaPct)[0] ?? null;

    const realizedPnl = exitedTrades.reduce((s, t) => s + (t.realizedPnl ?? 0), 0);
    const strongBuys  = withDelta.filter((s) => (s.aiScore ?? 0) >= 78).length;

    return {
      totalSignals:   total,
      strongBuys,
      winRate:        total > 0 ? wins / total : 0,
      avgPeakDelta:   Math.round(avgPeak),
      avgScore:       Math.round(avgScore),
      rugRate:        total > 0 ? rugs / total : 0,
      bestCall:       best ? { symbol: best.symbol, peakDelta: Math.round(best.peakDeltaPct) } : null,
      analyzedTokens: verdictCount.length,
      realizedPnl,
      openPositions:  openTrades,
    };
  }

  // ── by score tier ──────────────────────────────────────────────────────────

  async getByTier(since?: Date): Promise<TierBreakdown[]> {
    const dateFilter = since ? { capturedAt: { gte: since } } : {};
    const raw = await this.prisma.intelSnapshot.findMany({
      where: { aiScore: { not: null }, ...dateFilter },
      select: { aiScore: true, pumpedHigh: true, marketCapUsdAtCapture: true, status: true },
    });
    const snapshots = raw.map((s) => {
      const entry = s.marketCapUsdAtCapture ?? 0;
      const peak  = s.pumpedHigh ?? 0;
      return { ...s, peakDeltaPct: entry > 0 && peak > 0 ? ((peak - entry) / entry) * 100 : 0 };
    });

    const tiers = [
      { label: '90-100', min: 90, max: 100 },
      { label: '80-89',  min: 80, max: 89  },
      { label: '70-79',  min: 70, max: 79  },
      { label: '60-69',  min: 60, max: 69  },
      { label: '<60',    min: 0,  max: 59  },
    ];

    return tiers.map(({ label, min, max }) => {
      const group = snapshots.filter((s) => { const sc = s.aiScore ?? 0; return sc >= min && sc <= max; });
      const wins   = group.filter((s) => s.peakDeltaPct >= 100).length;
      const rugs   = group.filter((s) => s.status === 'rugged').length;
      const avg    = group.length ? group.reduce((a, s) => a + s.peakDeltaPct, 0) / group.length : 0;
      return {
        tier:         label,
        count:        group.length,
        winRate:      group.length ? wins / group.length : 0,
        avgPeakDelta: Math.round(avg),
        rugRate:      group.length ? rugs / group.length : 0,
      };
    });
  }

  // ── by discovery source ────────────────────────────────────────────────────

  async getBySource(since?: Date): Promise<SourceBreakdown[]> {
    const dateFilter = since ? { capturedAt: { gte: since } } : {};
    const raw = await this.prisma.intelSnapshot.findMany({
      where: dateFilter,
      select: { source: true, pumpedHigh: true, marketCapUsdAtCapture: true },
    });

    const bySource = new Map<string, { count: number; wins: number; deltas: number[] }>();
    for (const s of raw) {
      const entry = s.marketCapUsdAtCapture ?? 0;
      const peak  = s.pumpedHigh ?? 0;
      const delta = entry > 0 && peak > 0 ? ((peak - entry) / entry) * 100 : 0;
      const src = s.source;
      if (!bySource.has(src)) bySource.set(src, { count: 0, wins: 0, deltas: [] });
      const g = bySource.get(src)!;
      g.count++;
      g.deltas.push(delta);
      if (delta >= 100) g.wins++;
    }

    return [...bySource.entries()].map(([source, g]) => ({
      source,
      count:        g.count,
      winRate:      g.count ? g.wins / g.count : 0,
      avgPeakDelta: g.deltas.length
        ? Math.round(g.deltas.reduce((a, b) => a + b, 0) / g.deltas.length)
        : 0,
    })).sort((a, b) => b.count - a.count);
  }

  // ── realized trade performance ─────────────────────────────────────────────

  async getTradePerformance(userId: string, since?: Date): Promise<TradePerformance[]> {
    const trades = await this.prisma.trade.findMany({
      where: {
        userId,
        side: 'buy',
        ...(since ? { createdAt: { gte: since } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    return trades.map((t) => ({
      tradeId:         t.id,
      token:           t.tokenOut,
      side:            t.side,
      mode:            t.mode,
      entryUsd:        t.priceUsd ?? 0,
      exitUsd:         t.exitAt ? (t.priceUsd ?? 0) + (t.realizedPnl ?? 0) : null,
      realizedPnl:     t.realizedPnl ?? null,
      holdDurationSec: t.holdDurationSec ?? null,
      exitReason:      t.exitReason ?? null,
      createdAt:       t.createdAt.toISOString(),
      exitAt:          t.exitAt?.toISOString() ?? null,
    }));
  }

  // ── exit reason breakdown ─────────────────────────────────────────────────

  async getExitBreakdown(userId?: string): Promise<{ reason: string; count: number; avgPnl: number }[]> {
    const where: any = { exitReason: { not: null } };
    if (userId) where.userId = userId;

    const trades = await this.prisma.trade.findMany({
      where,
      select: { exitReason: true, realizedPnl: true },
    });

    const byReason = new Map<string, { count: number; pnls: number[] }>();
    for (const t of trades) {
      const r = t.exitReason!;
      if (!byReason.has(r)) byReason.set(r, { count: 0, pnls: [] });
      const g = byReason.get(r)!;
      g.count++;
      if (t.realizedPnl != null) g.pnls.push(t.realizedPnl);
    }

    return [...byReason.entries()]
      .map(([reason, g]) => ({
        reason,
        count:  g.count,
        avgPnl: g.pnls.length ? g.pnls.reduce((a, b) => a + b, 0) / g.pnls.length : 0,
      }))
      .sort((a, b) => b.count - a.count);
  }
}
