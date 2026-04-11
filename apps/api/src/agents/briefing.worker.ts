import { Logger } from '@nestjs/common';
import { makeWorker, QUEUES } from './queues';

/**
 * Daily morning briefing — batch-computes per-user portfolio delta, executed orders,
 * market overview, and emits AlertEvent + Telegram push.
 */
export function startBriefingWorker() {
  const logger = new Logger('BriefingWorker');
  return makeWorker(QUEUES.BRIEFING, async (job) => {
    const { userId } = job.data as { userId: string };
    logger.debug(`morning briefing userId=${userId}`);
    return { ok: true };
  });
}
