import { Logger } from '@nestjs/common';
import { Worker } from 'bullmq';
import { makeWorker, QUEUES } from './queues';
import type { WorkerDeps } from './worker.bootstrap';
import { withTrace } from '../common/trace-context';

export function startSnipeWorker(deps: WorkerDeps): Worker {
  const logger = new Logger('SnipeWorker');
  return makeWorker(QUEUES.SNIPE, async (job) => {
    const traceId: string | undefined = (job.data as { traceId?: string } | undefined)?.traceId;
    return withTrace(async () => {
      logger.debug(`[trc=${traceId ?? 'tick'}] snipe tick (v2 feature — no-op in MVP)`);
      return { ok: true };
    }, { traceId });
  });
}
