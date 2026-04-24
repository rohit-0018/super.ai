import { Logger } from '@nestjs/common';
import { Worker } from 'bullmq';
import { makeWorker, QUEUES } from '../agents/queues';
import type { WorkerDeps } from '../agents/worker.bootstrap';
import { IntentExtractorService } from './intent-extractor.service';
import { IntentRuleService } from './intent-rule.service';
import { IntentStatus } from '@prisma/client';
import { withTrace } from '../common/trace-context';

export interface IntentWorkerDeps extends WorkerDeps {
  extractor: IntentExtractorService;
  rules: IntentRuleService;
}

export interface ExtractChatJob {
  userId: string;
  userMsg: string;
  assistantReply: string;
  traceId?: string;
}

export interface ExtractRejectionJob {
  userId: string;
  approvalId: string;
  traceId?: string;
}

export function startIntentExtractorWorkers(deps: IntentWorkerDeps): Worker[] {
  const logger = new Logger('IntentExtractorWorker');

  const chat = makeWorker(QUEUES.INTENT_EXTRACT_CHAT, async (job) => {
    if (process.env.INTENT_MEMORY_ENABLED !== 'true') return { skipped: 'flag_off' };
    const data = job.data as ExtractChatJob;
    return withTrace(async () => {
      try {
        const out = await deps.extractor.extractFromChat(data.userId, data.userMsg, data.assistantReply);
        return { extracted: out.length };
      } catch (e: any) {
        logger.warn(`chat extract user=${data.userId} failed: ${e.message}`);
        return { skipped: 'error' };
      }
    }, { traceId: data.traceId, userId: data.userId });
  });

  const rej = makeWorker(QUEUES.INTENT_EXTRACT_REJECTION, async (job) => {
    if (process.env.INTENT_MEMORY_ENABLED !== 'true') return { skipped: 'flag_off' };
    const data = job.data as ExtractRejectionJob;
    return withTrace(async () => {
      const approval = await deps.prisma.approvalRequest.findUnique({ where: { id: data.approvalId } });
      if (!approval) return { skipped: 'approval_not_found' };
      try {
        const out = await deps.extractor.extractFromRejection(data.userId, {
          id: approval.id,
          tradeIntent: approval.tradeIntent,
          rejectCategory: approval.rejectCategory,
          rejectReason: approval.rejectReason,
        });
        return { extracted: out.length };
      } catch (e: any) {
        logger.warn(`rejection extract user=${data.userId} failed: ${e.message}`);
        return { skipped: 'error' };
      }
    }, { traceId: data.traceId, userId: data.userId });
  });

  const retire = makeWorker(QUEUES.INTENT_RETIRE_STALE, async (job) => {
    const traceId = (job.data as { traceId?: string } | undefined)?.traceId;
    return withTrace(async () => {
      const cutoff = new Date(Date.now() - 60 * 24 * 3600_000);
      const result = await deps.prisma.userIntentRule.updateMany({
        where: {
          status: IntentStatus.ACTIVE,
          priority: { lt: 30 },
          OR: [
            { lastAppliedAt: null, createdAt: { lt: cutoff } },
            { lastAppliedAt: { lt: cutoff } },
          ],
        },
        data: { status: IntentStatus.RETIRED, retiredReason: 'STALE' },
      });
      // Cache is per-user; cheap to nuke it wholesale since retire is rare.
      return { retired: result.count };
    }, { traceId });
  });

  return [chat, rej, retire];
}
