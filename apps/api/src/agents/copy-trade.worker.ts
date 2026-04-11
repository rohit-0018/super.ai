import { Logger } from '@nestjs/common';
import { makeWorker, QUEUES } from './queues';

export function startCopyTradeWorker() {
  const logger = new Logger('CopyTradeWorker');
  return makeWorker(QUEUES.COPY_TRADE, async (job) => {
    const { agentId, srcWallet } = job.data as { agentId: string; srcWallet: string };
    logger.debug(`copy-trade scan ${srcWallet}`);
    // poll src wallet recent txs, mirror swap on user wallet
    return { ok: true };
  });
}
