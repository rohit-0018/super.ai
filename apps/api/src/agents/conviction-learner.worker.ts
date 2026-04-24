import { Logger } from '@nestjs/common';
import { Worker } from 'bullmq';
import { makeWorker, QUEUES } from './queues';
import type { WorkerDeps } from './worker.bootstrap';
import { ConvictionLearnerService } from '../ai-agent/conviction-learner.service';
import { withTrace } from '../common/trace-context';

export interface ConvictionLearnerDeps extends WorkerDeps {
  learner: ConvictionLearnerService;
}

// Two job names:
//   learner-tick (cron every 6h) → walks every learning-enabled, non-override user
//   learner-user (milestone dispatch from learning-ingest at 20/50/100/250 trades)
export function startConvictionLearnerWorker(deps: ConvictionLearnerDeps): Worker {
  const logger = new Logger('ConvictionLearnerWorker');

  return makeWorker(QUEUES.CONVICTION_LEARNER, async (job) => {
    if (process.env.CONVICTION_PERSONALIZATION_ENABLED !== 'true') return { skipped: 'flag_off' };
    const data = job.data as { userId?: string; trigger?: 'cron' | 'milestone' | 'manual'; traceId?: string };
    return withTrace(async () => {
      if (job.name === 'learner-user' && data.userId) {
        const out = await deps.learner.recomputeWeights(data.userId, data.trigger ?? 'milestone');
        return { userId: data.userId, out };
      }
      const configs = await deps.prisma.learningConfig.findMany({ where: { enabled: true } });
      let applied = 0, rejected = 0, skipped = 0;
      for (const cfg of configs) {
        try {
          const out = await deps.learner.recomputeWeights(cfg.userId, 'cron');
          if (out.applied) applied++;
          else if (out.skipped === 'backtest_regression') rejected++;
          else skipped++;
        } catch (e: any) {
          logger.warn(`learner user=${cfg.userId} failed: ${e.message}`);
        }
      }
      return { applied, rejected, skipped, total: configs.length };
    }, { traceId: data.traceId, userId: data.userId });
  });
}
