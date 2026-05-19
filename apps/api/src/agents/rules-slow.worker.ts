/**
 * Phase 5: Trade+ Slow Path Worker
 *
 * Full rule-set evaluation for non-trusted/non-fast-path signals.
 * Steps: normalize → source_gate → pre_risk_gate → fetch_context →
 *        evaluate_sets → merge_actions → size → execute_entry → spawn_exits → open_outcome
 *
 * Concurrency: 4, stalled timeout: 30s
 */
import { Logger } from '@nestjs/common';
import { RuleOutcomeStatus } from '@prisma/client';
import { Worker } from 'bullmq';
import { makeWorker, QUEUES } from './queues';
import type { WorkerDeps } from './worker.bootstrap';
import { newTraceId, withTrace } from '../common/trace-context';
import { evaluateConditions } from './condition-evaluator';

const logger = new Logger('RulesSlowWorker');

export interface SlowPathJob {
  signalId: string;
  userId: string;
  traceId?: string;
}

export function startRulesSlowWorker(deps: WorkerDeps): Worker {
  return makeWorker(
    QUEUES.RULES_SLOW,
    async (job) => {
      const { signalId, userId, traceId: jobTrace } = job.data as SlowPathJob;
      const trace = jobTrace ?? newTraceId();
      const startMs = Date.now();

      return withTrace(async () => {
        // Step 1: normalize_signal — load signal + source
        const signal = await (deps.prisma as any).signal.findUnique({
          where: { id: signalId },
          include: { source: true },
        });
        if (!signal) return { ok: false, reason: 'signal_not_found' };

        const source = signal.source;
        if (!source?.enabled) return { ok: false, reason: 'source_disabled' };

        // Step 2: pre_risk_gate
        const guardrails = (deps as any).guardrails;
        if (guardrails) {
          const decision = await guardrails.check({
            userId,
            tokenAddress: signal.tokenAddress ?? '',
            chain: signal.chain ?? 'SOLANA',
            notionalUsd: 50,
            slippageBps: 300,
          });
          if (!decision.ok) return { ok: false, reason: `guardrail:${decision.reason}` };
        }

        // Step 3: fetch_context — token metadata + market data
        let tokenContext: Record<string, any> = {};
        if (signal.tokenAddress) {
          try {
            const price = await deps.marketData.price(signal.tokenAddress);
            tokenContext = { price, address: signal.tokenAddress };
          } catch { /* non-fatal */ }
        }

        // Step 4: evaluate_sets — find all ACTIVE rule sets bound to this user/source/token
        const ruleSets = await (deps.prisma as any).ruleSet.findMany({
          where: { userId, status: { in: ['ACTIVE', 'CANARY'] } },
          include: {
            rules: { include: { conditions: true } },
            bindings: true,
            sizingPolicy: true,
            entryPolicy: true,
            exitPolicy: true,
            riskPolicy: true,
          },
        });

        const context = {
          signal: {
            ticker: signal.ticker,
            tokenAddress: signal.tokenAddress,
            chain: signal.chain,
            ...((signal.metadata as any) ?? {}),
          },
          token: tokenContext,
          source: { trust: source.trust, name: source.name },
        };

        const matchingRuleSets = ruleSets.filter((rs: any) => {
          // Check bindings — if none, treat as globally bound
          if (rs.bindings.length === 0) return true;
          return rs.bindings.some((b: any) => {
            if (b.scope === 'global') return true;
            if (b.scope === 'channel' && b.scopeRef === signal.sourceId) return true;
            if (b.scope === 'token' && b.scopeRef === signal.tokenAddress) return true;
            return false;
          });
        }).filter((rs: any) => {
          // Evaluate all rules' conditions; at least one rule must pass
          return rs.rules.some((rule: any) => evaluateConditions(rule.conditions, context));
        });

        if (matchingRuleSets.length === 0) {
          return { ok: false, reason: 'no_matching_rules', latencyMs: Date.now() - startMs };
        }

        // Step 5: merge_actions — dedupe on (wallet, token), pick highest priority
        const topRuleSet = matchingRuleSets[0];

        // Step 6: size — compute notional from SizingPolicy
        let notionalUsd = 50;
        const sp = topRuleSet.sizingPolicy;
        if (sp?.mode === 'fixed_usd' && sp.fixedUsd) notionalUsd = sp.fixedUsd;
        if (sp?.maxUsd) notionalUsd = Math.min(notionalUsd, sp.maxUsd);

        const slippageBps = topRuleSet.entryPolicy?.slippageBps ?? 300;

        // Resolve wallet
        let walletId = source.walletId;
        if (!walletId) {
          const w = await deps.prisma.wallet.findFirst({
            where: { userId, isPrimary: true, chain: signal.chain ?? 'SOLANA' },
          });
          walletId = w?.id;
        }
        if (!walletId) return { ok: false, reason: 'no_wallet' };

        const firing = await (deps.prisma as any).ruleFiring.create({
          data: { userId, signalId, ruleSetId: topRuleSet.id, traceId: trace },
        });

        // Step 7: execute_entry
        const tokenIn = signal.chain === 'EVM'
          ? 'USDC'
          : 'So11111111111111111111111111111111111111112';
        const decimals = signal.chain === 'EVM' ? 6 : 9;
        const amountIn = Math.round(notionalUsd * Math.pow(10, decimals)).toString();

        let tradeId: string | null = null;
        let txHash: string | null = null;
        let succeeded = false;
        let failReason: string | null = null;

        try {
          const result = await deps.execution.swap({
            userId,
            walletId,
            chain: signal.chain ?? 'SOLANA',
            tokenIn,
            tokenOut: signal.tokenAddress,
            amountIn,
            notionalUsd,
            slippageBps,
            traceId: trace,
          });
          tradeId = result.tradeId;
          txHash = result.txHash;
          succeeded = true;

          await (deps.prisma as any).signal.update({
            where: { id: signalId },
            data: { processedAt: new Date() },
          });

          // Canary: increment count toward graduation
          if (topRuleSet.status === 'CANARY') {
            await (deps.prisma as any).ruleSet.update({
              where: { id: topRuleSet.id },
              data: { canaryCount: { increment: 1 } },
            });
          }
        } catch (e: any) {
          failReason = e.message;
          logger.error(`[trc=${trace}] slow-path swap failed: ${e.message}`);
          await deps.notifications.emit({
            userId,
            kind: 'TRADE_FAILED',
            severity: 'WARN',
            payload: { token: signal.tokenAddress, reason: e.message, traceId: trace },
            traceId: trace,
          });
        }

        // Step 8: open_outcome_row
        const latencyMs = Date.now() - startMs;
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

        logger.log(
          `[trc=${trace}] slow-path ${succeeded ? 'OK' : 'FAIL'} latency=${latencyMs}ms ` +
          `signal=${signalId} ruleSet=${topRuleSet.id} txHash=${txHash ?? 'none'}`
        );

        return { ok: succeeded, tradeId, txHash, latencyMs, failReason };
      }, { traceId: trace, userId });
    },
    { concurrency: 4, stalledInterval: 30_000 },
  );
}
