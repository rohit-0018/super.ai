import { Logger } from '@nestjs/common';
import { makeWorker, QUEUES } from './queues';

export function startDcaWorker() {
  const logger = new Logger('DcaWorker');
  return makeWorker(QUEUES.DCA, async (job) => {
    const { agentId } = job.data as { agentId: string };
    logger.debug(`dca tick agent=${agentId}`);
    // fetch agent params, build SwapInput, call ExecutionService
    return { ok: true };
  });
}
