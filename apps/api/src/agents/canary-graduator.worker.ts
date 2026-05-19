/**
 * Phase 5: Canary Graduation Worker
 *
 * Runs on a schedule. Promotes CANARY rule sets to ACTIVE once they've
 * accumulated enough successful trades (default: 5). Auto-archives rule
 * sets that have sustained a loss streak above maxTiltStreak.
 */
import { Logger } from '@nestjs/common';
import { Worker } from 'bullmq';
import { makeWorker, QUEUES } from './queues';
import type { WorkerDeps } from './worker.bootstrap';

const logger = new Logger('CanaryGraduatorWorker');

const CANARY_GRADUATION_THRESHOLD = parseInt(process.env.CANARY_GRADUATION_THRESHOLD ?? '5', 10);

export function startCanaryGraduatorWorker(deps: WorkerDeps): Worker {
  return makeWorker(QUEUES.CANARY_GRADUATION, async (_job) => {
    // Graduate canary rule sets that have hit the trade threshold
    const candidates = await (deps.prisma as any).ruleSet.findMany({
      where: { status: 'CANARY' },
    });

    let graduated = 0;
    let archived = 0;

    for (const rs of candidates) {
      if (rs.canaryCount >= CANARY_GRADUATION_THRESHOLD) {
        await (deps.prisma as any).ruleSet.update({
          where: { id: rs.id },
          data: { status: 'ACTIVE' },
        });
        graduated++;
        logger.log(`RuleSet ${rs.id} (${rs.name}) graduated CANARY → ACTIVE after ${rs.canaryCount} trades`);

        await deps.notifications.emit({
          userId: rs.userId,
          kind: 'RULE_SET_GRADUATED',
          severity: 'INFO',
          payload: {
            ruleSetId: rs.id,
            name: rs.name,
            canaryTrades: rs.canaryCount,
            message: `Rule set "${rs.name}" has graduated to ACTIVE after ${rs.canaryCount} canary trades.`,
          },
        });
      }
    }

    // Archive active rule sets on sustained loss streak
    const activeSets = await (deps.prisma as any).ruleSet.findMany({
      where: { status: 'ACTIVE' },
      include: {
        riskPolicy: true,
        firings: {
          orderBy: { firedAt: 'desc' },
          take: 10,
          include: { outcome: true },
        },
      },
    });

    for (const rs of activeSets) {
      const maxTilt = rs.riskPolicy?.maxTiltStreak ?? 5;
      const recentOutcomes = rs.firings
        .map((f: any) => f.outcome?.status)
        .filter((s: any) => s === 'WIN' || s === 'LOSS');

      // Count trailing consecutive losses
      let lossStreak = 0;
      for (const outcome of recentOutcomes) {
        if (outcome === 'LOSS') lossStreak++;
        else break;
      }

      if (lossStreak >= maxTilt) {
        await (deps.prisma as any).ruleSet.update({
          where: { id: rs.id },
          data: { status: 'ARCHIVED' },
        });
        archived++;
        logger.warn(`RuleSet ${rs.id} (${rs.name}) archived — loss streak ${lossStreak} >= ${maxTilt}`);

        await deps.notifications.emit({
          userId: rs.userId,
          kind: 'RULE_SET_ARCHIVED',
          severity: 'WARN',
          payload: {
            ruleSetId: rs.id,
            name: rs.name,
            lossStreak,
            message: `Rule set "${rs.name}" was auto-archived after ${lossStreak} consecutive losses. Re-enable in Settings.`,
          },
        });
      }
    }

    logger.log(`Canary graduation tick: graduated=${graduated} archived=${archived}`);
    return { ok: true, graduated, archived };
  });
}
