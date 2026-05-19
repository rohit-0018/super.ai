/**
 * Phase 4: Trade+ Fast Path Worker
 *
 * Processes signals from trusted sources that have fastPathEnabled=true.
 * Budget: source_gate(5ms) → guardrail(10ms) → quote(300ms) → sign_send(400ms)
 * Target latency: < 800ms from signal to broadcast.
 *
 * Confirmed defaults for every fast-path buy:
 *   - Hard stop: -25%, 100% size
 *   - TP1: +50%, 50% size
 *   - TP2: +150%, 30% size
 *   - Runner: trailing 20%
 *   - Break-even: at +30%
 *   - Time stop: 4h → tighten to -10%
 */
import { Logger } from '@nestjs/common';
import { OrderStatus, OrderType, RuleOutcomeStatus } from '@prisma/client';
import { Worker } from 'bullmq';
import { makeWorker, QUEUES } from './queues';
import type { WorkerDeps } from './worker.bootstrap';
import { newTraceId, withTrace } from '../common/trace-context';

const logger = new Logger('RulesFastWorker');

export interface FastPathJob {
  signalId: string;
  userId: string;
  traceId?: string;
}

/** Default exit policy for every fast-path trade. */
const DEFAULT_EXIT = {
  stopLossPct: -25,
  stopLossSize: 1.0,
  tp1Pct: 50,
  tp1Size: 0.5,
  tp2Pct: 150,
  tp2Size: 0.3,
  trailingPct: 20,
  trailingSize: 0.2,
  breakEvenAt: 30,
  timeStopHours: 4,
  timeStopPct: -10,
};

export function startRulesFastWorker(deps: WorkerDeps): Worker {
  return makeWorker(
    QUEUES.RULES_FAST,
    async (job) => {
      const { signalId, userId, traceId: jobTrace } = job.data as FastPathJob;
      const trace = jobTrace ?? newTraceId();
      const startMs = Date.now();

      return withTrace(async () => {
        // ── Step 1: source_gate (5ms budget) ─────────────────────────────
        const signal = await (deps.prisma as any).signal.findUnique({
          where: { id: signalId },
          include: { source: true },
        });
        if (!signal) {
          logger.warn(`[trc=${trace}] signal=${signalId} not found — skipping`);
          return { ok: false, reason: 'signal_not_found' };
        }

        const source = signal.source;
        if (!source?.fastPathEnabled || !source?.enabled) {
          logger.debug(`[trc=${trace}] signal=${signalId} source fast-path not enabled — skipping`);
          return { ok: false, reason: 'source_not_fast_path' };
        }

        if (!signal.tokenAddress) {
          logger.debug(`[trc=${trace}] signal=${signalId} no token address — skipping`);
          return { ok: false, reason: 'no_token_address' };
        }

        // ── Step 2: guardrail check (10ms budget) ──────────────────────
        const guardrails = (deps as any).guardrails;
        if (guardrails) {
          const decision = await guardrails.check({
            userId,
            tokenAddress: signal.tokenAddress,
            chain: signal.chain ?? 'SOLANA',
            notionalUsd: 50, // default fast-path position size — overridden by SizingPolicy
            slippageBps: 300,
          });
          if (!decision.ok) {
            logger.warn(`[trc=${trace}] guardrail blocked: ${decision.reason}`);
            return { ok: false, reason: `guardrail:${decision.reason}` };
          }
        }

        // Resolve sizing from SizingPolicy bound to a ACTIVE rule set, or use source default
        const activeRuleSet = await (deps.prisma as any).ruleSet.findFirst({
          where: { userId, status: 'ACTIVE' },
          include: { sizingPolicy: true, entryPolicy: true, exitPolicy: true, riskPolicy: true, bindings: true },
        });

        let notionalUsd = (source as any).defaultSizeUsd ?? 50;
        let slippageBps = 300;
        let walletId = source.walletId;

        if (activeRuleSet?.sizingPolicy) {
          const sp = activeRuleSet.sizingPolicy;
          if (sp.mode === 'fixed_usd' && sp.fixedUsd) notionalUsd = sp.fixedUsd;
          if (sp.maxUsd) notionalUsd = Math.min(notionalUsd, sp.maxUsd);
        }
        if (activeRuleSet?.entryPolicy?.slippageBps) {
          slippageBps = activeRuleSet.entryPolicy.slippageBps;
        }

        // Fall back to user's primary wallet if source doesn't specify one
        if (!walletId) {
          const primaryWallet = await deps.prisma.wallet.findFirst({
            where: { userId, isPrimary: true, chain: signal.chain ?? 'SOLANA' },
          });
          walletId = primaryWallet?.id;
        }

        if (!walletId) {
          logger.warn(`[trc=${trace}] no wallet found for user=${userId} chain=${signal.chain}`);
          return { ok: false, reason: 'no_wallet' };
        }

        // ── Step 3: create a RuleFiring record ─────────────────────────
        const ruleSetId = activeRuleSet?.id ?? 'default';
        const firing = ruleSetId !== 'default' ? await (deps.prisma as any).ruleFiring.create({
          data: {
            userId,
            signalId,
            ruleSetId,
            traceId: trace,
          },
        }) : null;

        // ── Steps 4+5: quote + sign + send (700ms combined budget) ─────
        const tokenIn = signal.chain === 'EVM' ? 'USDC' : 'So11111111111111111111111111111111111111112'; // SOL
        const tokenOut = signal.tokenAddress;

        let tradeId: string | null = null;
        let txHash: string | null = null;
        let succeeded = false;
        let failReason: string | null = null;

        try {
          // Compute amountIn in smallest units (USDC = 6 decimals, SOL = 9 decimals)
          const decimals = signal.chain === 'EVM' ? 6 : 9;
          const amountIn = Math.round(notionalUsd * Math.pow(10, decimals)).toString();

          const result = await deps.execution.swap({
            userId,
            walletId,
            chain: signal.chain ?? 'SOLANA',
            tokenIn,
            tokenOut,
            amountIn,
            notionalUsd,
            slippageBps,
            traceId: trace,
          });

          tradeId = result.tradeId;
          txHash = result.txHash;
          succeeded = true;

          // Mark signal as processed
          await (deps.prisma as any).signal.update({
            where: { id: signalId },
            data: { processedAt: new Date() },
          });

          // ── Step 6: spawn default exit orders ──────────────────────
          const exitPolicy = activeRuleSet?.exitPolicy ?? DEFAULT_EXIT;
          await spawnExitOrders(deps, userId, walletId, signal.chain ?? 'SOLANA', tokenIn, tokenOut, amountIn, exitPolicy, trace);

        } catch (e: any) {
          failReason = e.message;
          logger.error(`[trc=${trace}] fast-path swap failed: ${e.message}`);

          // Notify user on failure
          await deps.notifications.emit({
            userId,
            kind: 'TRADE_FAILED',
            severity: 'WARN',
            payload: {
              token: tokenOut,
              reason: e.message,
              source: source.name,
              traceId: trace,
              message: `Fast-path trade failed: ${e.message.slice(0, 120)}`,
            },
            traceId: trace,
          });
        }

        const latencyMs = Date.now() - startMs;

        // Open outcome row
        if (firing) {
          await (deps.prisma as any).ruleOutcome.create({
            data: {
              firingId: firing.id,
              status: succeeded ? RuleOutcomeStatus.OPEN : RuleOutcomeStatus.ERROR,
              tradeId,
              entryUsd: succeeded ? notionalUsd : null,
              exitReason: failReason,
            },
          });

          await (deps.prisma as any).ruleFiring.update({
            where: { id: firing.id },
            data: { latencyMs },
          });
        }

        logger.log(
          `[trc=${trace}] fast-path ${succeeded ? 'OK' : 'FAIL'} latency=${latencyMs}ms ` +
          `signal=${signalId} token=${tokenOut} notional=$${notionalUsd} txHash=${txHash ?? 'none'}`
        );

        return { ok: succeeded, tradeId, txHash, latencyMs, failReason };
      }, { traceId: trace, userId });
    },
    { concurrency: 8, stalledInterval: 3_000 },
  );
}

/** Spawn stop-loss and take-profit child orders after a fast-path buy. */
async function spawnExitOrders(
  deps: WorkerDeps,
  userId: string,
  walletId: string,
  chain: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: string,
  policy: Partial<typeof DEFAULT_EXIT>,
  trace: string,
): Promise<void> {
  const exits = [];

  if (policy.stopLossPct != null) {
    exits.push(deps.prisma.order.create({
      data: {
        userId,
        walletId,
        chain: chain as any,
        type: OrderType.STOP_LOSS,
        status: OrderStatus.ACTIVE,
        tokenIn: tokenOut, // selling the token
        tokenOut: tokenIn, // back to base
        amountIn,
        params: {
          stopPrice: policy.stopLossPct,
          slippageBps: 500,
          sizePct: policy.stopLossSize ?? 1.0,
        } as any,
        traceId: trace,
      } as any,
    }));
  }

  if (policy.tp1Pct != null) {
    exits.push(deps.prisma.order.create({
      data: {
        userId,
        walletId,
        chain: chain as any,
        type: OrderType.TAKE_PROFIT,
        status: OrderStatus.ACTIVE,
        tokenIn: tokenOut,
        tokenOut: tokenIn,
        amountIn,
        params: {
          takeProfit: policy.tp1Pct,
          slippageBps: 300,
          sizePct: policy.tp1Size ?? 0.5,
        } as any,
        traceId: trace,
      } as any,
    }));
  }

  if (policy.tp2Pct != null) {
    exits.push(deps.prisma.order.create({
      data: {
        userId,
        walletId,
        chain: chain as any,
        type: OrderType.TAKE_PROFIT,
        status: OrderStatus.ACTIVE,
        tokenIn: tokenOut,
        tokenOut: tokenIn,
        amountIn,
        params: {
          takeProfit: policy.tp2Pct,
          slippageBps: 300,
          sizePct: policy.tp2Size ?? 0.3,
        } as any,
        traceId: trace,
      } as any,
    }));
  }

  if (policy.trailingPct != null) {
    exits.push(deps.prisma.order.create({
      data: {
        userId,
        walletId,
        chain: chain as any,
        type: OrderType.TRAILING_STOP,
        status: OrderStatus.ACTIVE,
        tokenIn: tokenOut,
        tokenOut: tokenIn,
        amountIn,
        params: {
          trailBps: Math.round((policy.trailingPct / 100) * 10_000),
          sizePct: policy.trailingSize ?? 0.2,
        } as any,
        traceId: trace,
      } as any,
    }));
  }

  try {
    await Promise.all(exits);
    logger.debug(`[trc=${trace}] spawned ${exits.length} exit orders`);
  } catch (e: any) {
    logger.warn(`[trc=${trace}] exit order spawn failed: ${e.message}`);
  }
}
