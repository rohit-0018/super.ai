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
    if (!process.env.TELEGRAM_BOT_TOKEN) return;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { telegramChatId: true },
    });
    if (!user?.telegramChatId) return;

    const text = this.formatTelegramMessage(kind, severity, payload);
    try {
      await this.telegram.enqueueSend(user.telegramChatId, text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
    } catch (e: any) {
      this.logger.warn(`telegram enqueue failed user=${userId}: ${e.message}`);
    }
  }

  private formatTelegramMessage(
    kind: string,
    severity: AlertSeverity,
    payload: Record<string, unknown>,
  ): string {
    const lines: string[] = [];

    // Header
    const icon = severity === 'CRITICAL' ? '🚨' : severity === 'WARN' ? '⚠️' : '💡';
    const title = kind.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    lines.push(`${icon} <b>${esc(title)}</b>`);

    // Kind-specific rich content
    const p = payload as Record<string, any>;

    switch (kind.toUpperCase()) {
      case 'TRADE_CONFIRMED':
      case 'ORDER_FILLED': {
        const side = String(p.side ?? '').toUpperCase();
        const sideIcon = side === 'BUY' ? '📈' : side === 'SELL' ? '📉' : '↔';
        const symbol = p.symbol ?? p.token ?? '';
        lines.push('');
        lines.push(`${sideIcon} <b>${esc(side)}</b>${symbol ? `  ·  <code>${esc(String(symbol))}</code>` : ''}`);
        if (p.amount != null)  lines.push(`Amount  <b>${fmtNum(p.amount)}</b>`);
        if (p.price != null)   lines.push(`Price   <b>$${fmtNum(p.price)}</b>`);
        if (p.total != null)   lines.push(`Total   <b>$${fmtNum(p.total)}</b>`);
        if (p.pnl != null) {
          const pnlNum = Number(p.pnl);
          const pnlStr = `${pnlNum >= 0 ? '+' : ''}$${Math.abs(pnlNum).toFixed(2)}`;
          lines.push(`P&amp;L  <b style="color:${pnlNum >= 0 ? 'green' : 'red'}">${pnlStr}</b>`);
        }
        break;
      }
      case 'AGENT_TRIGGERED':
      case 'AGENT_DECISION': {
        if (p.agentName) lines.push(`\nAgent: <b>${esc(String(p.agentName))}</b>`);
        if (p.action)    lines.push(`Action: ${esc(String(p.action))}`);
        if (p.reason)    lines.push(`\n<i>${esc(String(p.reason).slice(0, 300))}</i>`);
        break;
      }
      case 'APPROVAL_PENDING': {
        lines.push('');
        lines.push('A trade is waiting for your approval.');
        if (p.side && p.symbol) lines.push(`${p.side === 'buy' ? '📈' : '📉'} <b>${esc(String(p.side).toUpperCase())} ${esc(String(p.symbol))}</b>`);
        if (p.amount) lines.push(`Amount: <b>${fmtNum(p.amount)}</b>`);
        break;
      }
      case 'POSITION_MONITOR':
      case 'RISK_ALERT': {
        if (p.symbol)  lines.push(`\nToken: <code>${esc(String(p.symbol))}</code>`);
        if (p.message) lines.push(`<i>${esc(String(p.message).slice(0, 300))}</i>`);
        break;
      }
      case 'BRIEFING': {
        if (p.summary) lines.push(`\n<i>${esc(String(p.summary).slice(0, 600))}</i>`);
        break;
      }
      default: {
        // Generic fallback — show message/summary if present, else top 4 key-value pairs
        const msg = p.message ?? p.summary ?? p.text;
        if (msg) {
          lines.push('', `<i>${esc(String(msg).slice(0, 400))}</i>`);
        } else {
          const entries = Object.entries(p)
            .filter(([k]) => !['traceId', 'userId'].includes(k))
            .slice(0, 4);
          if (entries.length) {
            lines.push('');
            entries.forEach(([k, v]) => {
              const key = k.replace(/([A-Z])/g, ' $1').trim();
              const val = typeof v === 'object' ? JSON.stringify(v).slice(0, 80) : String(v).slice(0, 80);
              lines.push(`${esc(key)}: <b>${esc(val)}</b>`);
            });
          }
        }
      }
    }

    const webUrl = (process.env.APP_WEB_URL ?? 'https://app.qwai.io').replace(/\/$/, '');
    lines.push('', `<a href="${webUrl}/dashboard">Open QWAI →</a>`);

    return lines.join('\n');
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtNum(v: unknown): string {
  const n = Number(v);
  if (isNaN(n)) return String(v);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(2)}K`;
  if (n >= 1)         return n.toFixed(4);
  return n.toFixed(6);
}
