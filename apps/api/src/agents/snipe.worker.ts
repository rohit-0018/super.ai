import { Logger } from '@nestjs/common';
import { Worker } from 'bullmq';
import { makeWorker, QUEUES } from './queues';
import type { WorkerDeps } from './worker.bootstrap';

export function startSnipeWorker(deps: WorkerDeps): Worker {
  const logger = new Logger('SnipeWorker');
  return makeWorker(QUEUES.SNIPE, async () => {
    logger.debug('snipe tick (v2 feature — no-op in MVP)');
    return { ok: true };
  });
}
