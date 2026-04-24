import { Logger } from '@nestjs/common';
import { NoteCategory } from '@prisma/client';
import { Worker } from 'bullmq';
import { makeWorker, QUEUES } from '../agents/queues';
import type { WorkerDeps } from '../agents/worker.bootstrap';
import { NoteService } from './note.service';
import { LlmService } from '../ai-agent/llm.service';
import { withTrace } from '../common/trace-context';

export interface NoteExtractorDeps extends WorkerDeps {
  notes: NoteService;
  llm: LlmService;
}

const SYSTEM = [
  'You extract durable user facts from a chat summary. Output ONLY JSON array of',
  '{"category": "PREFERENCE"|"CONTEXT"|"AVOIDANCE"|"GOAL"|"TRADING_STYLE"|"OTHER", "content": string, "confidence": 0..1}.',
  'Return [] if nothing persists beyond today. No markdown, no prose.',
  'AVOIDANCE if the user stated a loss/pain point to not be reminded of.',
].join(' ');

export function startNoteExtractorWorkers(deps: NoteExtractorDeps): Worker[] {
  const logger = new Logger('NoteExtractorWorker');

  const extract = makeWorker(QUEUES.NOTE_EXTRACT, async (job) => {
    if (process.env.CHAT_MEMORY_ENABLED !== 'true') return { skipped: 'flag_off' };
    const data = job.data as { conversationId: string; userId: string; traceId?: string };
    return withTrace(async () => {
      const conv = await deps.prisma.conversation.findUnique({ where: { id: data.conversationId } });
      if (!conv?.summary) return { skipped: 'no_summary' };
      let raw = '';
      try {
        raw = await deps.llm.chat([
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `Summary:\n${conv.summary.slice(0, 3000)}` },
        ]);
      } catch (e: any) {
        logger.warn(`note extract conv=${conv.id} failed: ${e.message}`);
        return { skipped: 'llm_error' };
      }
      const arr = parseArray(raw);
      if (!arr) return { skipped: 'parse_failed' };
      let kept = 0;
      for (const item of arr) {
        try {
          const category = String(item.category ?? '').toUpperCase();
          const content = String(item.content ?? '').trim();
          const confidence = Math.max(0, Math.min(1, Number(item.confidence) || 0));
          if (!content || confidence < 0.7 || content.length > 400) continue;
          if (!(category in NoteCategory)) continue;
          await deps.notes.proposeFromExtraction(data.userId, {
            category: category as NoteCategory,
            content,
            confidence,
            sourceConversationId: conv.id,
          });
          kept++;
        } catch (err: any) {
          logger.debug(`skip note: ${err.message}`);
        }
      }
      return { kept };
    }, { traceId: data.traceId, userId: data.userId });
  });

  const retire = makeWorker(QUEUES.NOTE_RETIRE_STALE, async (job) => {
    const traceId = (job.data as { traceId?: string } | undefined)?.traceId;
    return withTrace(async () => {
      const n = await deps.notes.retireStale();
      return { retired: n };
    }, { traceId });
  });

  return [extract, retire];
}

function parseArray(raw: string): any[] | null {
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
