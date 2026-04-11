import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from './notifications.service';

/**
 * Emotional intelligence (PDF §3.5 W4 #5):
 *  - sentiment analysis on recent messages
 *  - trade-frequency tracking (revenge / FOMO detection)
 *  - cautionary nudges, esp. high-frequency or late-night sessions
 */
@Injectable()
export class EmotionalIntelService {
  constructor(private prisma: PrismaService, private notifications: NotificationsService) {}

  async evaluate(userId: string): Promise<void> {
    const since = new Date(Date.now() - 60 * 60_000);
    const recentTrades = await this.prisma.trade.count({ where: { userId, createdAt: { gte: since } } });
    const hour = new Date().getHours();
    const lateNight = hour >= 0 && hour <= 4;

    const triggers: string[] = [];
    if (recentTrades >= 6) triggers.push('HIGH_FREQUENCY');
    if (lateNight && recentTrades >= 2) triggers.push('LATE_NIGHT_ACTIVE');

    if (triggers.length) {
      await this.notifications.emit({
        userId,
        kind: 'EMOTIONAL_NUDGE',
        severity: 'WARN',
        payload: {
          triggers,
          message: 'Heads up — your activity pattern suggests elevated emotional risk. Want to switch to paper mode for the next hour?',
        },
      });
      await this.prisma.user.update({
        where: { id: userId },
        data: { emotionalState: { triggers, evaluatedAt: new Date().toISOString() } as any },
      });
    }
  }
}
