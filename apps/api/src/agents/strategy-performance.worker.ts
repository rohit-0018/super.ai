import { Logger } from '@nestjs/common';
import { Worker } from 'bullmq';
import { makeWorker, QUEUES } from './queues';
import type { WorkerDeps } from './worker.bootstrap';
import { StrategyPerformanceService } from '../strategies/strategy-performance.service';
import { withTrace } from '../common/trace-context';

export interface StrategyPerformanceDeps extends WorkerDeps {
  strategyPerf: StrategyPerformanceService;
}

const AUTO_RETIRE_MIN_DECISIONS = 5;
const AUTO_RETIRE_ACCEPT_FLOOR = 0.15;

/**
 * Recomputes StrategyPerformance aggregates for every enabled strategy once
 * per tick. Auto-retires a strategy (enabled=false) when approvalAcceptRate
 * is below the floor over a meaningful sample, gated by
 * STRATEGY_AUTORETIRE_ENABLED so the destructive action can be rolled in
 * after observing data for a few cycles.
 */
export function startStrategyPerformanceWorker(deps: StrategyPerformanceDeps): Worker {
  const logger = new Logger('StrategyPerformanceWorker');

  return makeWorker(QUEUES.STRATEGY_PERFORMANCE, async (job) => {
    const jobTrace: string | undefined = (job.data as { traceId?: string } | undefined)?.traceId;
    return withTrace(async () => {
      const strategies = await deps.prisma.userStrategy.findMany({
        where: { enabled: true },
        select: { id: true, userId: true, name: true },
      });
      if (!strategies.length) return { computed: 0 };

      const autoRetireEnabled = process.env.STRATEGY_AUTORETIRE_ENABLED === 'true';
      let computed = 0;
      let retired = 0;

      for (const s of strategies) {
        try {
          const perf = await deps.strategyPerf.upsertFor(s.id, s.userId);
          computed++;

          if (
            autoRetireEnabled &&
            perf.approvalsAccepted + perf.approvalsRejected >= AUTO_RETIRE_MIN_DECISIONS &&
            (perf.approvalAcceptRate ?? 1) < AUTO_RETIRE_ACCEPT_FLOOR
          ) {
            await deps.prisma.userStrategy.update({ where: { id: s.id }, data: { enabled: false } });
            await deps.notifications.emit({
              userId: s.userId,
              kind: 'strategy_auto_retired',
              severity: 'WARN',
              payload: {
                strategyId: s.id,
                strategyName: s.name,
                reason: 'low_accept_rate',
                acceptRate: perf.approvalAcceptRate,
                decisions: perf.approvalsAccepted + perf.approvalsRejected,
              },
            });
            await deps.prisma.auditLog.create({
              data: {
                userId: s.userId,
                action: 'strategy.auto_retired',
                target: s.id,
                payload: { acceptRate: perf.approvalAcceptRate, decisions: perf.approvalsAccepted + perf.approvalsRejected },
              },
            });
            retired++;
          }
        } catch (err: any) {
          logger.warn(`perf strategy=${s.id} failed: ${err.message}`);
        }
      }
      logger.debug(`perf tick: computed=${computed} retired=${retired} across ${strategies.length} strategies`);
      return { computed, retired };
    }, { traceId: jobTrace });
  });
}
