import { Logger } from '@nestjs/common';
import { Worker } from 'bullmq';
import { makeQueue, makeWorker, makeJobData, QUEUES } from '../agents/queues';
import type { WorkerDeps } from '../agents/worker.bootstrap';
import { ConversationService } from './conversation.service';
import { LlmService } from '../ai-agent/llm.service';
import { withTrace } from '../common/trace-context';

export interface SummarizerDeps extends WorkerDeps {
  conversations: ConversationService;
  llm: LlmService;
}

const MAX_PER_TICK = 20;

export function startConversationSummarizerWorkers(deps: SummarizerDeps): Worker[] {
  const logger = new Logger('ConversationSummarizer');

  const sweep = makeWorker(QUEUES.CONVERSATION_IDLE_SWEEP, async (job) => {
    const traceId = (job.data as { traceId?: string } | undefined)?.traceId;
    return withTrace(async () => {
      if (process.env.CHAT_MEMORY_ENABLED !== 'true') return { skipped: 'flag_off' };
      await deps.conversations.closeIdleConversations();
      const due = await deps.conversations.findIdleForSummarize(MAX_PER_TICK);
      const q = makeQueue(QUEUES.CONVERSATION_SUMMARIZE);
      for (const c of due) {
        await q.add('summarize', makeJobData({ conversationId: c.id }), {
          jobId: `sum-${c.id}`,
          removeOnComplete: 100,
          removeOnFail: 50,
        });
      }
      return { enqueued: due.length };
    }, { traceId });
  });

  const summarize = makeWorker(QUEUES.CONVERSATION_SUMMARIZE, async (job) => {
    if (process.env.CHAT_MEMORY_ENABLED !== 'true') return { skipped: 'flag_off' };
    const data = job.data as { conversationId: string; traceId?: string };
    return withTrace(async () => {
      const conv = await deps.prisma.conversation.findUnique({ where: { id: data.conversationId } });
      if (!conv) return { skipped: 'not_found' };
      const messages = await deps.prisma.chatMessage.findMany({
        where: {
          conversationId: conv.id,
          ...(conv.summarizedThroughId ? { id: { gt: conv.summarizedThroughId } } : {}),
        },
        orderBy: { createdAt: 'asc' },
        take: 120,
      });
      if (messages.length < 2) return { skipped: 'too_short' };

      const cfg = await deps.prisma.learningConfig.findUnique({ where: { userId: conv.userId } });
      if (cfg && cfg.chatMemoryEnabled === false) return { skipped: 'chat_memory_off' };

      const prompt = [
        conv.summary ? `Previous summary: ${conv.summary}` : '',
        'Summarize the conversation below in 3-8 bullets. Focus on: stated preferences, user context (drawdown, goals, constraints), completed actions, unresolved intents. Do not restate trade amounts — those live in the Trade table. Output bullets only.',
        ...messages.map((m) => `${m.role}: ${m.content.slice(0, 400)}`),
      ].filter(Boolean).join('\n');
      let summary = '';
      try {
        summary = await deps.llm.chat([
          { role: 'system', content: 'You summarize trading-assistant conversations concisely.' },
          { role: 'user', content: prompt },
        ]);
      } catch (e: any) {
        logger.warn(`summarize conv=${conv.id} failed: ${e.message}`);
        return { skipped: 'llm_error' };
      }
      const lastId = messages[messages.length - 1].id;
      const firstLine = summary.split('\n').map((s) => s.trim()).find((s) => s.length > 4 && s.length < 90) ?? null;
      await deps.conversations.markSummarized(conv.id, summary.slice(0, 4000), conv.title ? null : firstLine, lastId);

      // Fan out note extraction (gated independently).
      if (process.env.CHAT_MEMORY_ENABLED === 'true' && cfg?.noteExtractionEnabled !== false) {
        try {
          const q = makeQueue(QUEUES.NOTE_EXTRACT);
          await q.add('extract', makeJobData({ conversationId: conv.id, userId: conv.userId }), {
            jobId: `note-${conv.id}-${lastId}`,
            removeOnComplete: 100,
            removeOnFail: 50,
          });
        } catch (e: any) {
          logger.debug(`note-extract enqueue failed: ${e.message}`);
        }
      }
      return { ok: true, messages: messages.length };
    }, { traceId: data.traceId, userId: undefined });
  });

  return [sweep, summarize];
}
