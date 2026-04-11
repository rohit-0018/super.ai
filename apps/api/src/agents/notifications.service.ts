import { Injectable, Logger } from '@nestjs/common';
import { AlertSeverity } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../ws/realtime.gateway';
import { http } from '../common/http';

export interface NotificationInput {
  userId: string;
  kind: string;
  severity?: AlertSeverity;
  payload: Record<string, unknown>;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private prisma: PrismaService, private rt: RealtimeGateway) {}

  async emit(input: NotificationInput) {
    const evt = await this.prisma.alertEvent.create({
      data: {
        userId: input.userId,
        kind: input.kind,
        severity: input.severity ?? 'INFO',
        payload: input.payload as any,
        deliveredAt: new Date(),
      },
    });

    this.rt.emitToUser(input.userId, 'alert', evt);
    await this.pushTelegram(input.userId, evt.kind, evt.severity, input.payload);
    return evt;
  }

  private async pushTelegram(
    userId: string,
    kind: string,
    severity: AlertSeverity,
    payload: Record<string, unknown>,
  ) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { telegramChatId: true },
    });
    if (!user?.telegramChatId) return;

    const icon = severity === 'CRITICAL' ? '🚨' : severity === 'WARN' ? '⚠️' : 'ℹ️';
    const text = `${icon} *QWAI ${kind}*\n\`\`\`\n${JSON.stringify(payload, null, 2).slice(0, 1500)}\n\`\`\``;
    try {
      await http.post(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          chat_id: user.telegramChatId,
          text,
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        },
        { timeoutMs: 8_000 },
      );
    } catch (e: any) {
      this.logger.warn(`telegram push failed user=${userId}: ${e.message}`);
    }
  }
}
