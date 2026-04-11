import { Logger } from '@nestjs/common';
import { Worker } from 'bullmq';
import { makeWorker, QUEUES } from './queues';
import type { WorkerDeps } from './worker.bootstrap';

export function startCopyTradeWorker(deps: WorkerDeps): Worker {
  const logger = new Logger('CopyTradeWorker');
  return makeWorker(QUEUES.COPY_TRADE, async (job) => {
    const { agentId, srcWallet } = job.data as { agentId?: string; srcWallet?: string };
    logger.debug(`copy-trade tick agent=${agentId} src=${srcWallet}`);
    // TODO(v2): poll src wallet recent txs via Helius/Birdeye and mirror swap.
    // Keeping as no-op to avoid cross-wallet spam until opt-in verification is in place.
    return { ok: true };
  });
}
