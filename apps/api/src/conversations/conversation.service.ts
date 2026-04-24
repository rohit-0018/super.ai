import { Injectable, Logger } from '@nestjs/common';
import { ChatChannel, ChatRole, Conversation, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { makeQueue, makeJobData, QUEUES } from '../agents/queues';

const IDLE_RESET_MS = 30 * 60_000;
const SUMMARIZE_MSG_THRESHOLD = 40;
const SUMMARIZE_TOKEN_THRESHOLD = 8_000;
const TOOL_RESULT_TRUNCATE = 2_000;

export interface AppendResult {
  conversation: Conversation;
  messageId: string;
}

// Keeps raw ChatMessage writes coherent with parent Conversation state.
// Callers should use this instead of prisma.chatMessage.create directly so
// that counters + summarizer dispatch stay correct.
@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  constructor(private prisma: PrismaService) {}

  async appendUser(userId: string, channel: ChatChannel, content: string) {
    return this.append(userId, channel, { role: ChatRole.USER, content });
  }

  async appendAssistant(userId: string, channel: ChatChannel, content: string, extras?: { toolCalls?: unknown; tokensOut?: number }) {
    return this.append(userId, channel, {
      role: ChatRole.ASSISTANT,
      content,
      toolCalls: extras?.toolCalls,
      tokensOut: extras?.tokensOut,
    });
  }

  async appendTool(userId: string, channel: ChatChannel, toolName: string, result: unknown, meta?: Record<string, unknown>) {
    const asString = typeof result === 'string' ? result : JSON.stringify(result);
    const truncated = asString.length > TOOL_RESULT_TRUNCATE;
    const content = truncated ? asString.slice(0, TOOL_RESULT_TRUNCATE) + '...[truncated]' : asString;
    return this.append(userId, channel, {
      role: ChatRole.TOOL,
      content,
      toolResults: { tool: toolName, result: truncated ? content : result },
      meta: { toolName, truncated, originalLen: asString.length, ...(meta ?? {}) },
    });
  }

  private async append(
    userId: string,
    channel: ChatChannel,
    msg: { role: ChatRole; content: string; toolCalls?: unknown; toolResults?: unknown; meta?: Record<string, unknown>; tokensIn?: number; tokensOut?: number },
  ): Promise<AppendResult> {
    const conversation = await this.getOrOpenActive(userId, channel);
    const approxTokens = Math.ceil((msg.content?.length ?? 0) / 4);
    const [, updated, created] = await this.prisma.$transaction([
      this.prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          lastMessageAt: new Date(),
          messageCount: { increment: 1 },
          approxTokenCount: { increment: approxTokens },
        },
      }),
      this.prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } }),
      this.prisma.chatMessage.create({
        data: {
          conversationId: conversation.id,
          userId,
          role: msg.role,
          content: msg.content,
          toolCalls: msg.toolCalls as Prisma.InputJsonValue | undefined,
          toolResults: msg.toolResults as Prisma.InputJsonValue | undefined,
          meta: msg.meta as Prisma.InputJsonValue | undefined,
          tokensIn: msg.tokensIn,
          tokensOut: msg.tokensOut,
        },
        select: { id: true },
      }),
    ]);
    if (updated.messageCount >= SUMMARIZE_MSG_THRESHOLD || updated.approxTokenCount >= SUMMARIZE_TOKEN_THRESHOLD) {
      this.enqueueSummarize(conversation.id).catch(() => {});
    }
    return { conversation: updated, messageId: created.id };
  }

  async getOrOpenActive(userId: string, channel: ChatChannel): Promise<Conversation> {
    const cutoff = new Date(Date.now() - IDLE_RESET_MS);
    const existing = await this.prisma.conversation.findFirst({
      where: { userId, channel, closedAt: null, lastMessageAt: { gte: cutoff } },
      orderBy: { lastMessageAt: 'desc' },
    });
    if (existing) return existing;
    return this.prisma.conversation.create({ data: { userId, channel } });
  }

  async previousClosed(userId: string, channel: ChatChannel, before: Date): Promise<Conversation | null> {
    return this.prisma.conversation.findFirst({
      where: { userId, channel, createdAt: { lt: before } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async recent(conversationId: string, limit: number) {
    const rows = await this.prisma.chatMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.reverse();
  }

  async closeIdleConversations(): Promise<number> {
    const cutoff = new Date(Date.now() - IDLE_RESET_MS);
    const result = await this.prisma.conversation.updateMany({
      where: { closedAt: null, lastMessageAt: { lt: cutoff }, messageCount: { gt: 0 } },
      data: { closedAt: new Date() },
    });
    return result.count;
  }

  async findIdleForSummarize(limit: number) {
    return this.prisma.conversation.findMany({
      where: {
        messageCount: { gt: 1 },
        OR: [
          { closedAt: { not: null } },
          { lastMessageAt: { lt: new Date(Date.now() - IDLE_RESET_MS) } },
        ],
      },
      take: limit,
    });
  }

  async markSummarized(id: string, summary: string, title: string | null, summarizedThroughId: string) {
    await this.prisma.conversation.update({
      where: { id },
      data: { summary, summarizedThroughId, ...(title ? { title } : {}) },
    });
  }

  async deleteConversation(userId: string, id: string) {
    const c = await this.prisma.conversation.findUnique({ where: { id } });
    if (!c || c.userId !== userId) return false;
    await this.prisma.conversation.delete({ where: { id } });
    return true;
  }

  async list(userId: string, limit: number) {
    return this.prisma.conversation.findMany({
      where: { userId },
      orderBy: { lastMessageAt: 'desc' },
      take: limit,
    });
  }

  async get(userId: string, id: string) {
    const c = await this.prisma.conversation.findUnique({ where: { id }, include: { messages: { orderBy: { createdAt: 'asc' } } } });
    if (!c || c.userId !== userId) return null;
    return c;
  }

  private async enqueueSummarize(conversationId: string) {
    try {
      const q = makeQueue(QUEUES.CONVERSATION_SUMMARIZE);
      await q.add(
        'summarize',
        makeJobData({ conversationId }),
        { jobId: `sum-${conversationId}`, removeOnComplete: 100, removeOnFail: 50 },
      );
    } catch (e: any) {
      this.logger.debug(`summarize enqueue failed conv=${conversationId}: ${e.message}`);
    }
  }
}
