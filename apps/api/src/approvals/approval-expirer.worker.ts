import { Logger } from '@nestjs/common';
import { ApprovalStatus } from '@prisma/client';
import { Worker } from 'bullmq';
import { makeWorker, QUEUES } from '../agents/queues';
import { PrismaService } from '../prisma/prisma.service';
import { withTrace } from '../common/trace-context';

/**
 * Walks PENDING ApprovalRequest rows whose expiresAt has passed and transitions
 * them to EXPIRED. The autonomous-trader worker observes this and either
 * re-queues the trade (onTimeout=execute) or drops it (onTimeout=reject).
 */
export function startApprovalExpirerWorker(prisma: PrismaService): Worker {
  const logger = new Logger('ApprovalExpirerWorker');
  return makeWorker(QUEUES.APPROVAL_EXPIRER, async (job) => {
    const jobTrace: string | undefined = (job.data as { traceId?: string } | undefined)?.traceId;
    return withTrace(async () => {
      const now = new Date();
      const result = await prisma.approvalRequest.updateMany({
        where: { status: ApprovalStatus.PENDING, expiresAt: { lte: now } },
        data: { status: ApprovalStatus.EXPIRED, respondedAt: now },
      });
      if (result.count > 0) logger.debug(`expired ${result.count} approval requests`);
      return { expired: result.count };
    }, { traceId: jobTrace });
  });
}
