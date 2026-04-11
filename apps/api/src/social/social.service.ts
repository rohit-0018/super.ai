import { Injectable } from '@nestjs/common';
import { AgentKind, AgentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SocialService {
  constructor(private prisma: PrismaService) {}

  /** Anonymized leaderboard — top performers by total PnL last 30 days. */
  async leaderboard() {
    const since = new Date(Date.now() - 30 * 24 * 3600_000);
    const rows = await this.prisma.trade.groupBy({
      by: ['userId'],
      where: { createdAt: { gte: since } },
      _sum: { pnlUsd: true },
      orderBy: { _sum: { pnlUsd: 'desc' } },
      take: 50,
    });
    return rows.map((r, i) => ({
      rank: i + 1,
      anonId: 'qwai-' + r.userId.slice(0, 6),
      pnlUsd: r._sum.pnlUsd ?? 0,
    }));
  }

  startCopyTrade(userId: string, srcWallet: string) {
    return this.prisma.agent.create({
      data: { userId, kind: AgentKind.COPY_TRADE, status: AgentStatus.RUNNING, params: { srcWallet } },
    });
  }
}
