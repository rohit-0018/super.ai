import { Logger } from '@nestjs/common';
import { AgentKind, AgentStatus } from '@prisma/client';
import { Worker } from 'bullmq';
import { makeWorker, QUEUES } from './queues';
import type { WorkerDeps } from './worker.bootstrap';

type DcaInterval = 'hourly' | 'daily' | 'weekly' | 'monthly';

interface DcaParams {
  walletId: string;
  tokenIn: string;
  tokenOut: string;
  amountUsd: number;
  interval: DcaInterval;
  chain: 'SOLANA' | 'EVM';
  slippageBps?: number;
}

const INTERVAL_MS: Record<DcaInterval, number> = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

export function startDcaWorker(deps: WorkerDeps): Worker {
  const logger = new Logger('DcaWorker');

  return makeWorker(QUEUES.DCA, async (job) => {
    const now = Date.now();
    const dueAgents = await deps.prisma.agent.findMany({
      where: { kind: AgentKind.DCA, status: AgentStatus.RUNNING },
    });

    let fired = 0;
    for (const agent of dueAgents) {
      const params = agent.params as unknown as DcaParams;
      if (!params?.walletId || !params?.tokenOut) continue;

      const intervalMs = INTERVAL_MS[params.interval] ?? INTERVAL_MS.daily;
      const lastRun = agent.lastRunAt?.getTime() ?? 0;
      const timeUntilNext = Math.max(0, intervalMs - (now - lastRun));
      const due = now - lastRun >= intervalMs;

      // Emit a heartbeat so the UI shows the agent is alive and when it fires next
      if (!due) {
        const minsLeft = Math.ceil(timeUntilNext / 60_000);
        const hrsLeft = Math.ceil(timeUntilNext / 3_600_000);
        const eta = minsLeft > 120 ? `${hrsLeft}h` : `${minsLeft}m`;
        await deps.notifications.emit({
          userId: agent.userId,
          kind: 'DCA_HEARTBEAT',
          severity: 'INFO',
          payload: {
            agentId: agent.id,
            tokenOut: params.tokenOut,
            amountUsd: params.amountUsd,
            interval: params.interval,
            nextRunIn: eta,
            message: `DCA ${params.tokenOut?.slice(0, 8)} — next buy ($${params.amountUsd}) in ${eta}`,
          },
        });
        continue;
      }

      try {
        const amountIn = Math.floor(params.amountUsd * 1_000_000).toString(); // assume USDC 6 decimals as base
        const result = await deps.execution.swap({
          userId: agent.userId,
          walletId: params.walletId,
          chain: params.chain === 'SOLANA' ? 'SOLANA' : 'EVM',
          tokenIn: params.tokenIn,
          tokenOut: params.tokenOut,
          amountIn,
          notionalUsd: params.amountUsd,
          slippageBps: params.slippageBps ?? 100,
          source: 'DCA',
        });
        await deps.prisma.agent.update({
          where: { id: agent.id },
          data: { lastRunAt: new Date() },
        });
        await deps.notifications.emit({
          userId: agent.userId,
          kind: 'DCA_FILL',
          payload: {
            agentId: agent.id,
            tokenOut: params.tokenOut,
            amountUsd: params.amountUsd,
            txHash: result.txHash,
            mode: result.mode,
          },
        });
        fired++;
      } catch (err: any) {
        logger.error(`DCA agent=${agent.id} failed: ${err.message}`);
        await deps.notifications.emit({
          userId: agent.userId,
          kind: 'DCA_FAILED',
          severity: 'WARN',
          payload: { agentId: agent.id, reason: err.message },
        });
      }
    }

    logger.debug(`dca tick: ${fired} fills / ${dueAgents.length} agents`);
    return { ok: true, fired, checked: dueAgents.length };
  });
}
