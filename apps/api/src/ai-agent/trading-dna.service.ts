import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface BehavioralSignals {
  sampleCount: number;
  chainCounts: Record<string, number>;
  tokenCounts: Record<string, number>;
  sideCounts: { buy: number; sell: number };
  hourHistogram: number[]; // length 24
  notionalUsdSum: number;
  notionalUsdCount: number;
  pnlByChain: Record<string, { trades: number; wins: number; pnl: number }>;
  recentTokens: string[]; // rolling last 20
  lastObservedAt?: string;
}

export interface LearnedPreferences {
  preferredChain?: string;
  topTokens: string[];
  avgNotionalUsd: number;
  activeHours: number[]; // top 3 by count
  buySellRatio?: number;
  updatedAt: string;
}

const EMPTY_SIGNALS: BehavioralSignals = {
  sampleCount: 0,
  chainCounts: {},
  tokenCounts: {},
  sideCounts: { buy: 0, sell: 0 },
  hourHistogram: Array(24).fill(0),
  notionalUsdSum: 0,
  notionalUsdCount: 0,
  pnlByChain: {},
  recentTokens: [],
};

@Injectable()
export class TradingDnaService {
  constructor(private prisma: PrismaService) {}

  async get(userId: string) {
    return this.prisma.tradingDna.upsert({
      where: { userId },
      update: {},
      create: { userId },
    });
  }

  /** Recalculate DNA after a trade outcome. Called by execution + agents. */
  async recordTrade(userId: string, opts: { pnlUsd: number; holdMinutes: number }) {
    const dna = await this.get(userId);
    const total = dna.totalTrades + 1;
    const wins = Math.round(dna.winRate * dna.totalTrades) + (opts.pnlUsd > 0 ? 1 : 0);
    const winRate = wins / total;
    const avgHold = (dna.avgHoldMinutes * dna.totalTrades + opts.holdMinutes) / total;
    return this.prisma.tradingDna.update({
      where: { userId },
      data: { totalTrades: total, winRate, avgHoldMinutes: avgHold },
    });
  }

  /** Merge a new observation into behavioralSignals + derive fresh preferences. Idempotent enough for occasional re-delivery. */
  async ingestObservation(
    userId: string,
    obs: { chain: string; token: string; side: 'buy' | 'sell'; notionalUsd: number; pnlUsd: number; tradedAt: Date },
  ) {
    const dna = await this.get(userId);
    const signals = this.mergeSignals((dna.behavioralSignals as unknown as BehavioralSignals) ?? EMPTY_SIGNALS, obs);
    const preferences = this.derivePreferences(signals);
    return this.prisma.tradingDna.update({
      where: { userId },
      data: {
        behavioralSignals: signals as unknown as Prisma.InputJsonValue,
        preferences: preferences as unknown as Prisma.InputJsonValue,
      },
    });
  }

  private mergeSignals(prev: BehavioralSignals, obs: { chain: string; token: string; side: 'buy' | 'sell'; notionalUsd: number; pnlUsd: number; tradedAt: Date }): BehavioralSignals {
    const hours = prev.hourHistogram?.length === 24 ? [...prev.hourHistogram] : Array(24).fill(0);
    hours[obs.tradedAt.getUTCHours()]++;
    const chainStat = prev.pnlByChain[obs.chain] ?? { trades: 0, wins: 0, pnl: 0 };
    const recent = [obs.token, ...prev.recentTokens.filter((t) => t !== obs.token)].slice(0, 20);
    return {
      sampleCount: prev.sampleCount + 1,
      chainCounts: { ...prev.chainCounts, [obs.chain]: (prev.chainCounts[obs.chain] ?? 0) + 1 },
      tokenCounts: { ...prev.tokenCounts, [obs.token]: (prev.tokenCounts[obs.token] ?? 0) + 1 },
      sideCounts: {
        buy: prev.sideCounts.buy + (obs.side === 'buy' ? 1 : 0),
        sell: prev.sideCounts.sell + (obs.side === 'sell' ? 1 : 0),
      },
      hourHistogram: hours,
      notionalUsdSum: prev.notionalUsdSum + (Number.isFinite(obs.notionalUsd) ? obs.notionalUsd : 0),
      notionalUsdCount: prev.notionalUsdCount + 1,
      pnlByChain: {
        ...prev.pnlByChain,
        [obs.chain]: {
          trades: chainStat.trades + 1,
          wins: chainStat.wins + (obs.pnlUsd > 0 ? 1 : 0),
          pnl: chainStat.pnl + (Number.isFinite(obs.pnlUsd) ? obs.pnlUsd : 0),
        },
      },
      recentTokens: recent,
      lastObservedAt: obs.tradedAt.toISOString(),
    };
  }

  private derivePreferences(s: BehavioralSignals): LearnedPreferences {
    const preferredChain = Object.entries(s.chainCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
    const topTokens = Object.entries(s.tokenCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => t);
    const activeHours = s.hourHistogram
      .map((count, hour) => ({ hour, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3)
      .map((x) => x.hour);
    const avgNotionalUsd = s.notionalUsdCount > 0 ? s.notionalUsdSum / s.notionalUsdCount : 0;
    const totalSides = s.sideCounts.buy + s.sideCounts.sell;
    return {
      preferredChain,
      topTokens,
      avgNotionalUsd,
      activeHours,
      buySellRatio: totalSides > 0 ? s.sideCounts.buy / totalSides : undefined,
      updatedAt: new Date().toISOString(),
    };
  }

  /** Returns a compact JSON profile to inject into the LLM system prompt. Includes learned preferences when present. */
  async profileForPrompt(userId: string): Promise<string> {
    const d = await this.get(userId);
    const prefs = (d.preferences as unknown as LearnedPreferences | null) ?? null;
    return JSON.stringify({
      winRate: Math.round(d.winRate * 100),
      avgHoldMin: Math.round(d.avgHoldMinutes),
      riskScore: d.riskScore,
      trades: d.totalTrades,
      learned: prefs
        ? {
            preferredChain: prefs.preferredChain,
            topTokens: prefs.topTokens,
            avgNotionalUsd: Math.round(prefs.avgNotionalUsd),
            activeHoursUtc: prefs.activeHours,
            buySellRatio: prefs.buySellRatio != null ? Math.round(prefs.buySellRatio * 100) / 100 : undefined,
          }
        : null,
    });
  }
}
