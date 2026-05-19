import { ForbiddenException, forwardRef, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ApprovalChannel, ApprovalStatus, Prisma, RejectCategory } from '@prisma/client';
import { InlineKeyboard } from 'grammy';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../agents/notifications.service';
import { TelegramService } from '../telegram/telegram.service';
import { RealtimeGateway } from '../ws/realtime.gateway';
import { currentTraceId } from '../common/trace-context';
import { makeQueue, makeJobData, QUEUES } from '../agents/queues';

export interface TradeIntent {
  chain: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  notionalUsd: number;
  slippageBps: number;
  side: 'buy' | 'sell';
  walletId: string;
  reason: string;
}

export interface CreateApprovalInput {
  userId: string;
  strategyId?: string;
  agentId?: string;
  intent: TradeIntent;
  timeoutMinutes: number;
  channels: ApprovalChannel[];
  traceId?: string;
}

@Injectable()
export class ApprovalsService {
  private readonly logger = new Logger(ApprovalsService.name);

  constructor(
    private prisma: PrismaService,
    private rt: RealtimeGateway,
    @Inject(forwardRef(() => NotificationsService))
    private notifications: NotificationsService,
    @Inject(forwardRef(() => TelegramService))
    private telegram: TelegramService,
  ) {}

  async create(input: CreateApprovalInput) {
    const trace = input.traceId ?? currentTraceId();
    const expiresAt = new Date(Date.now() + input.timeoutMinutes * 60_000);

    const req = await this.prisma.approvalRequest.create({
      data: {
        userId: input.userId,
        strategyId: input.strategyId,
        agentId: input.agentId,
        tradeIntent: input.intent as unknown as Prisma.InputJsonValue,
        expiresAt,
        ...(trace ? { traceId: trace } : {}),
      } as Prisma.ApprovalRequestUncheckedCreateInput,
    });

    this.rt.emitToUser(input.userId, 'approval_pending', { ...req, traceId: trace });

    if (input.channels.includes(ApprovalChannel.TELEGRAM)) {
      await this.pushTelegram(req.id, input.userId, input.intent, expiresAt);
    }

    return req;
  }

  async respond(
    userId: string,
    id: string,
    accept: boolean,
    via: ApprovalChannel,
    opts?: { rejectCategory?: RejectCategory; rejectReason?: string },
  ) {
    const req = await this.prisma.approvalRequest.findUnique({ where: { id } });
    if (!req) throw new NotFoundException();
    if (req.userId !== userId) throw new ForbiddenException();
    if (req.status !== ApprovalStatus.PENDING) return req;
    const updated = await this.prisma.approvalRequest.update({
      where: { id },
      data: {
        status: accept ? ApprovalStatus.APPROVED : ApprovalStatus.REJECTED,
        respondedAt: new Date(),
        respondedVia: via,
        ...(!accept && opts?.rejectCategory ? { rejectCategory: opts.rejectCategory } : {}),
        ...(!accept && opts?.rejectReason ? { rejectReason: opts.rejectReason } : {}),
      },
    });
    this.rt.emitToUser(userId, 'approval_resolved', { ...updated });

    // On approve, fire an immediate "execute-approved" job so the autonomous-
    // trader worker runs the trade via the same code path as timeout-execute.
    // This keeps approvals-service free of any direct ExecutionService import.
    if (accept) {
      try {
        const q = makeQueue(QUEUES.AUTONOMOUS_TRADER);
        await q.add('execute-approved', { approvalId: id }, { removeOnComplete: 200, removeOnFail: 100 });
      } catch (e: any) {
        this.logger.warn(`enqueue execute-approved failed approval=${id}: ${e.message}`);
      }
    } else if (process.env.INTENT_MEMORY_ENABLED === 'true') {
      // L4: rejections are a rich source of durable rules. Fire-and-forget.
      try {
        const q = makeQueue(QUEUES.INTENT_EXTRACT_REJECTION);
        await q.add(
          'extract',
          makeJobData({ userId, approvalId: id }),
          { removeOnComplete: 200, removeOnFail: 100 },
        );
      } catch (e: any) {
        this.logger.debug(`intent rejection enqueue failed approval=${id}: ${e.message}`);
      }
    }
    return updated;
  }

  async expire(id: string) {
    try {
      const current = await this.prisma.approvalRequest.findUnique({ where: { id } });
      if (!current || current.status !== ApprovalStatus.PENDING) return current;
      return this.prisma.approvalRequest.update({
        where: { id },
        data: { status: ApprovalStatus.EXPIRED, respondedAt: new Date() },
      });
    } catch (e: any) {
      this.logger.warn(`expire ${id} failed: ${e.message}`);
      return null;
    }
  }

  async listPending(userId: string) {
    return this.prisma.approvalRequest.findMany({
      where: { userId, status: ApprovalStatus.PENDING },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Create an approval request and poll DB for a response, up to `timeoutMs`.
   * Used by the spending policy to block a high-value trade until the user taps
   * Approve/Reject in Telegram. Returns true if approved, false if rejected/expired.
   */
  async requestAndWait(
    input: CreateApprovalInput,
    timeoutMs = 30_000,
  ): Promise<boolean> {
    const req = await this.create(input);
    const deadline = Date.now() + timeoutMs;
    const pollMs = 2_000;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
      const current = await this.prisma.approvalRequest.findUnique({ where: { id: req.id } });
      if (!current) break;
      if (current.status === ApprovalStatus.APPROVED) return true;
      if (current.status === ApprovalStatus.REJECTED || current.status === ApprovalStatus.EXPIRED) return false;
    }

    // Timed out — expire the request and deny
    await this.expire(req.id);
    return false;
  }

  private async pushTelegram(requestId: string, userId: string, intent: TradeIntent, expiresAt: Date) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { telegramChatId: true },
    });
    if (!user?.telegramChatId) return;
    const text = [
      '🤖 *Autonomous trade pending*',
      '```',
      JSON.stringify(
        { side: intent.side, token: intent.tokenOut, chain: intent.chain, notionalUsd: intent.notionalUsd, reason: intent.reason },
        null,
        2,
      ).slice(0, 1200),
      '```',
      `_Expires ${expiresAt.toISOString()}_`,
    ].join('\n');
    const keyboard = new InlineKeyboard()
      .text('✅ Approve', `approve:${requestId}`)
      .text('❌ Reject', `reject:${requestId}`);
    try {
      await this.telegram.enqueueSend(user.telegramChatId, text, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: keyboard,
      });
    } catch (e: any) {
      this.logger.warn(`telegram approval push failed user=${userId}: ${e.message}`);
    }
  }
}
