import { Logger } from '@nestjs/common';
import { makeWorker, QUEUES } from './queues';

export function startSnipeWorker() {
  const logger = new Logger('SnipeWorker');
  return makeWorker(QUEUES.SNIPE, async (job) => {
    logger.debug('snipe tick');
    return { ok: true };
  });
}
