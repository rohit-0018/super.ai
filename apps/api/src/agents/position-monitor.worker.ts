import { Logger } from '@nestjs/common';
import { makeWorker, QUEUES } from './queues';

/**
 * Polls open positions for each user, evaluates health factor, liquidation risk,
 * stop-loss / take-profit triggers, whale-movement signals.
 */
export function startPositionMonitorWorker() {
  const logger = new Logger('PositionMonitor');
  return makeWorker(QUEUES.POSITION_MONITOR, async (job) => {
    const { userId } = job.data as { userId: string };
    logger.debug(`monitor tick userId=${userId}`);
    // 1. fetch open orders + balances
    // 2. fetch live prices
    // 3. evaluate stop-loss / trailing / take-profit
    // 4. emit AlertEvent on trigger; enqueue execution.swap on fill
    return { ok: true };
  });
}
