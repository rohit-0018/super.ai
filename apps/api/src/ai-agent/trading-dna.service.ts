import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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

  /** Returns a compact JSON profile to inject into the LLM system prompt. */
  async profileForPrompt(userId: string): Promise<string> {
    const d = await this.get(userId);
    return JSON.stringify({
      winRate: Math.round(d.winRate * 100),
      avgHoldMin: Math.round(d.avgHoldMinutes),
      riskScore: d.riskScore,
      trades: d.totalTrades,
    });
  }
}
