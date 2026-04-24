import { Logger } from '@nestjs/common';
import { Worker } from 'bullmq';
import { makeQueue, makeWorker, makeJobData, QUEUES } from './queues';
import type { WorkerDeps } from './worker.bootstrap';
import { TradingDnaService } from '../ai-agent/trading-dna.service';
import { withTrace } from '../common/trace-context';

const MILESTONES = new Set([20, 50, 100, 250]);

export interface LearningIngestJob {
  userId: string;
  tradeId: string;
  traceId?: string;
}

export interface LearningIngestDeps extends WorkerDeps {
  dna: TradingDnaService;
}

/**
 * Consumes a learning-ingest job enqueued after every completed swap.
 * Reads the trade row, merges an observation into TradingDna.behavioralSignals,
 * and recomputes LearnedPreferences. Gated by LearningConfig.enabled — if a user
 * has learning off we silently skip so no behavioral data is retained.
 */
export function startLearningIngestWorker(deps: LearningIngestDeps): Worker {
  const logger = new Logger('LearningIngestWorker');
  return makeWorker(QUEUES.LEARNING_INGEST, async (job) => {
    const data = job.data as LearningIngestJob;
    return withTrace(async () => {
      const cfg = await deps.prisma.learningConfig.findUnique({ where: { userId: data.userId } });
      if (!cfg?.enabled) return { skipped: 'learning_disabled' };

      const trade = await deps.prisma.trade.findUnique({ where: { id: data.tradeId } });
      if (!trade) {
        logger.warn(`trade=${data.tradeId} not found`);
        return { skipped: 'trade_not_found' };
      }

      const notionalUsd = trade.priceUsd && Number(trade.amountIn) > 0
        ? Number(trade.amountIn) * trade.priceUsd
        : 0;

      const preDna = await deps.prisma.tradingDna.findUnique({ where: { userId: data.userId } });
      const preCount = preDna?.totalTrades ?? 0;
      try {
        await deps.dna.ingestObservation(data.userId, {
          chain: String(trade.chain),
          token: trade.tokenOut,
          side: trade.side === 'sell' ? 'sell' : 'buy',
          notionalUsd,
          pnlUsd: trade.pnlUsd ?? 0,
          tradedAt: trade.createdAt,
        });
      } catch (err: any) {
        // Learning failures must NEVER break the trade flow or retry loudly —
        // drop the job and log. Next trade will refresh derived preferences.
        logger.error(`ingest failed user=${data.userId} trade=${data.tradeId}: ${err.message}`);
        return { skipped: 'ingest_error' };
      }

      // L5 milestone dispatch — trigger a learner pass at 20/50/100/250 trades.
      if (process.env.CONVICTION_PERSONALIZATION_ENABLED === 'true') {
        const postDna = await deps.prisma.tradingDna.findUnique({ where: { userId: data.userId } });
        const postCount = postDna?.totalTrades ?? preCount + 1;
        if (postCount > preCount && MILESTONES.has(postCount)) {
          try {
            const q = makeQueue(QUEUES.CONVICTION_LEARNER);
            await q.add(
              'learner-user',
              makeJobData({ userId: data.userId, trigger: 'milestone' }),
              { removeOnComplete: 50, removeOnFail: 50 },
            );
          } catch (e: any) {
            logger.debug(`milestone dispatch failed user=${data.userId}: ${e.message}`);
          }
        }
      }

      return { ok: true };
    }, { traceId: data.traceId, userId: data.userId });
  });
}
