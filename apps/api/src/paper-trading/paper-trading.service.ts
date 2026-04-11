import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PaperTradingService {
  constructor(private prisma: PrismaService) {}

  async toggle(userId: string, enabled: boolean) {
    const u = await this.prisma.user.update({ where: { id: userId }, data: { paperMode: enabled } });
    if (enabled) await this.seed(userId);
    return { paperMode: u.paperMode };
  }

  async balance(userId: string) {
    return this.prisma.paperBalance.findMany({ where: { userId } });
  }

  async pnl(userId: string) {
    const trades = await this.prisma.trade.findMany({ where: { userId, mode: 'PAPER' } });
    return trades.reduce((acc, t) => acc + (t.pnlUsd ?? 0), 0);
  }

  private async seed(userId: string) {
    await this.prisma.paperBalance.upsert({
      where: { userId_token: { userId, token: 'USDC' } },
      update: {},
      create: { userId, token: 'USDC', amount: '10000000000' }, // 10k USDC (6 dec)
    });
  }
}
