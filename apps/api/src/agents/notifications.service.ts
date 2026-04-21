import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { AlertSeverity, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../ws/realtime.gateway';
import { TelegramService } from '../telegram/telegram.service';
import { currentTraceId } from '../common/trace-context';

export interface NotificationInput {
  userId: string;
  kind: string;
  severity?: AlertSeverity;
  payload: Record<string, unknown>;
  /** Optional override — otherwise AsyncLocalStorage traceId is used. */
  traceId?: string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private prisma: PrismaService,
    private rt: RealtimeGateway,
    @Inject(forwardRef(() => TelegramService))
    private telegram: TelegramService,
  ) {}

  async emit(input: NotificationInput) {
    const trace: string | undefined = input.traceId ?? currentTraceId();
    const payload = { ...input.payload, ...(trace ? { traceId: trace } : {}) };

    const evt = await this.prisma.alertEvent.create({
      data: {
        userId: input.userId,
        kind: input.kind,
        severity: input.severity ?? 'INFO',
        payload: payload as Prisma.InputJsonValue,
        deliveredAt: new Date(),
        ...(trace ? { traceId: trace } : {}),
      } as unknown as Prisma.AlertEventCreateInput,
    });

    // WS envelope always carries traceId; the gateway will double-check and
    // stamp it if missing (belt-and-braces for non-service callers).
    this.rt.emitToUser(input.userId, 'alert', { ...evt, traceId: trace });
    await this.pushTelegram(input.userId, evt.kind, evt.severity, payload, trace);
    return evt;
  }

  private async pushTelegram(
    userId: string,
    kind: string,
    severity: AlertSeverity,
    payload: Record<string, unknown>,
    traceId: string | undefined,
  ) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { telegramChatId: true },
    });
    if (!user?.telegramChatId) return;

    const icon = severity === 'CRITICAL' ? '🚨' : severity === 'WARN' ? '⚠️' : 'ℹ️';
    const traceFooter = traceId ? `\n_trace:${traceId}_` : '';
    const text = `${icon} *QWAI ${kind}*\n\`\`\`\n${JSON.stringify(payload, null, 2).slice(0, 1500)}\n\`\`\`${traceFooter}`;
    try {
      await this.telegram.enqueueSend(user.telegramChatId, text, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      });
    } catch (e: any) {
      this.logger.warn(`[trc=${traceId ?? 'none'}] telegram enqueue failed user=${userId}: ${e.message}`);
    }
  }
}
