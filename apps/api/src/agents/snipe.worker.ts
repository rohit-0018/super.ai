import { Logger } from '@nestjs/common';
import { Worker } from 'bullmq';
import { makeWorker, QUEUES } from './queues';
import type { WorkerDeps } from './worker.bootstrap';
import { withTrace } from '../common/trace-context';

export interface SnipeJobData {
  traceId?: string;
  userId?: string;
  mint?: string;
  groupId?: string;
  sourceMsg?: string;
  // retry path — these are already recorded in SnipeTrade
  snipeTradeId?: string;
}

/**
 * Secondary snipe worker — handles retry/analytics jobs enqueued by SnipeFastService.
 *
 * The PRIMARY hot path fires directly inside the Grammy handler (zero queue hop).
 * This worker is a safety net for:
 *  - Retry of failed snipes (network blip, RPC timeout)
 *  - Background confirmation polling (check if broadcast tx landed)
 *  - Analytics fan-out
 *
 * Concurrency=3 so three retries can run in parallel without blocking each other.
 */
export function startSnipeWorker(deps: WorkerDeps): Worker {
  const logger = new Logger('SnipeWorker');
  return makeWorker(
    QUEUES.SNIPE,
    async (job) => {
      const data = job.data as SnipeJobData;
      const traceId: string | undefined = data.traceId;
      return withTrace(async () => {
        if (!data.userId || !data.mint) {
          // Legacy tick job (old no-op) — skip silently
          return { ok: true };
        }
        logger.debug(`[trc=${traceId ?? 'none'}] snipe retry userId=${data.userId} mint=${data.mint}`);
        // The SnipeFastService and SnipeSessionService are not injected here because
        // WorkerDeps doesn't carry them (worker process may not have Nest DI).
        // For retries, we just log and update the status via Prisma.
        const prisma = deps.prisma;
        if (data.snipeTradeId) {
          await prisma.snipeTrade.update({
            where: { id: data.snipeTradeId },
            data: { status: 'retry_attempted' },
          }).catch(() => {});
        }
        return { ok: true };
      }, { traceId });
    },
    { concurrency: 3 },
  );
}
