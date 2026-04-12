import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from './notifications.service';

@Injectable()
export class EmotionalIntelService {
  private readonly logger = new Logger(EmotionalIntelService.name);

  constructor(private prisma: PrismaService, private notifications: NotificationsService) {}

  async evaluate(userId: string): Promise<void> {
    const since = new Date(Date.now() - 60 * 60_000);
    const recentTrades = await this.prisma.trade.count({ where: { userId, createdAt: { gte: since } } });
    const hour = new Date().getHours();
    const lateNight = hour >= 0 && hour <= 4;

    const triggers: string[] = [];
    const messages: string[] = [];

    if (recentTrades >= 6) {
      triggers.push('HIGH_FREQUENCY');
      messages.push(`You've executed ${recentTrades} trades in the last hour. Rapid trading often signals FOMO or revenge behavior.`);
    }

    if (lateNight && recentTrades >= 2) {
      triggers.push('LATE_NIGHT_ACTIVE');
      messages.push('Late-night trading (12AM-4AM) correlates with worse decision-making. Consider pausing until morning.');
    }

    if (lateNight && recentTrades === 0) {
      triggers.push('LATE_NIGHT_SESSION');
      messages.push('Trading at this hour carries higher risk. I\'ll keep extra guardrails active.');
    }

    if (triggers.length) {
      const message = messages.join(' ') + ' Want to switch to paper mode?';
      await this.notifications.emit({
        userId,
        kind: 'EMOTIONAL_NUDGE',
        severity: recentTrades >= 6 ? 'WARN' : 'INFO',
        payload: { triggers, message },
      });
      await this.prisma.user.update({
        where: { id: userId },
        data: { emotionalState: { triggers, evaluatedAt: new Date().toISOString() } as any },
      });
    }
  }

  async evaluateTokenViews(userId: string, tokenAddress: string): Promise<void> {
    const key = `view:${userId}:${tokenAddress}`;
    const views = await this.getViewCount(key);
    if (views >= 3) {
      const hasTrade = await this.prisma.trade.count({
        where: {
          userId,
          tokenOut: { contains: tokenAddress.slice(0, 8) },
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60_000) },
        },
      });
      if (hasTrade === 0) {
        await this.notifications.emit({
          userId,
          kind: 'BEHAVIORAL_TRIGGER',
          severity: 'INFO',
          payload: {
            trigger: 'VIEWED_WITHOUT_BUYING',
            tokenAddress,
            viewCount: views,
            message: `You've looked at ${tokenAddress.slice(0, 6)}… ${views} times without trading. This pattern can indicate hesitation. If you're interested, consider a small paper-mode position first.`,
          },
        });
      }
    }
  }

  private viewCounts = new Map<string, number>();

  async trackTokenView(userId: string, tokenAddress: string) {
    const key = `view:${userId}:${tokenAddress}`;
    const count = (this.viewCounts.get(key) ?? 0) + 1;
    this.viewCounts.set(key, count);
    if (count >= 3) {
      await this.evaluateTokenViews(userId, tokenAddress);
    }
  }

  private getViewCount(key: string): number {
    return this.viewCounts.get(key) ?? 0;
  }
}
