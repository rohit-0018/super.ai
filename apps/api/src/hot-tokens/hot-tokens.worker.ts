import { makeWorker, QUEUES } from '../agents/queues';
import type { HotTokensService } from './hot-tokens.service';

export function startHotTokensScanWorker(svc: HotTokensService) {
  return makeWorker(QUEUES.HOT_TOKENS_SCAN, async () => {
    await svc.scan();
  });
}

export function startHotTokensRefreshWorker(svc: HotTokensService) {
  return makeWorker(QUEUES.HOT_TOKENS_REFRESH, async () => {
    await svc.refreshPrices();
  });
}
