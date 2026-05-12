import { Logger } from '@nestjs/common';
import { ApprovalChannel, ApprovalStatus, AutonomyLevel, Prisma } from '@prisma/client';
import { Worker } from 'bullmq';
import { makeQueue, makeWorker, QUEUES } from './queues';
import type { WorkerDeps } from './worker.bootstrap';
import { LlmService } from '../ai-agent/llm.service';
import { TradingDnaService } from '../ai-agent/trading-dna.service';
import { GuardrailsService } from '../guardrails/guardrails.service';
import { ApprovalsService, type TradeIntent } from '../approvals/approvals.service';
import { IntentRuleService } from '../intent/intent-rule.service';
import { IntentRuleEnforcer } from '../intent/intent-rule.enforcer';
import { EpisodicMemoryService } from '../episodes/episodic-memory.service';
import { ConvictionEngine, ConvictionBreakdown } from '../token-intel/conviction.engine';
import { TokenIntelService } from '../token-intel/token-intel.service';
import { makeJobData } from './queues';
import { withTrace } from '../common/trace-context';

export interface AutonomousTraderDeps extends WorkerDeps {
  llm: LlmService;
  dna: TradingDnaService;
  guardrails: GuardrailsService;
  approvals: ApprovalsService;
  intentRules?: IntentRuleService;
  intentEnforcer?: IntentRuleEnforcer;
  episodic?: EpisodicMemoryService;
  conviction?: ConvictionEngine;
  tokenIntel?: TokenIntelService;
}

// 0..1 composite score (Sharpe + winRate + acceptRate + LLM). Pre-L3 the
// scorer wrote 0..10; the strategy-performance/scorer pipeline standardises
// every UserStrategy.score to 0..1 after its first pass.
const MIN_SCORE_TO_ACT = 0.5;
const MAX_CANDIDATES_PER_TICK_PER_USER = 1;
const AUTO_RETIRE_MIN_SAMPLE = 10;
const AUTO_RETIRE_SCORE_FLOOR = 0.25;

/**
 * Drives the progressive-learning agent's autonomous execution layer.
 *
 * Per tick (every few minutes):
 *   1. Loads LearningConfig users with enabled=true and autonomy IN
 *      (GUIDED, SEMI_AUTO, FULL_AUTO). MANUAL users are never touched here.
 *   2. For each, picks one enabled strategy with score ≥ MIN_SCORE_TO_ACT,
 *      asks the LLM to propose a concrete TradeIntent or "no-op" based on
 *      the strategy + user DNA + recent trades.
 *   3. Runs guardrails + concentration + learning-level cap checks.
 *   4. Routes:
 *        - GUIDED: emit a suggestion alert; no approval, no trade.
 *        - SEMI_AUTO: create ApprovalRequest (WEB + TELEGRAM per user setting).
 *                     Timeout behaviour handled by auto-decide delayed job.
 *        - FULL_AUTO: execute immediately through execution.swap().
 *   5. Accounts dailyUsedCount + dailyResetAt.
 *
 * Crucially: paperMode + kill switch + guardrails are enforced by the same
 * code path as manual trades — no bypass.
 */
export function startAutonomousTraderWorker(deps: AutonomousTraderDeps): Worker {
  const logger = new Logger('AutonomousTraderWorker');

  return makeWorker(QUEUES.AUTONOMOUS_TRADER, async (job) => {
    const jobTrace: string | undefined = (job.data as { traceId?: string } | undefined)?.traceId;
    const jobName = job.name;

    return withTrace(async () => {
      // Secondary job: explicit auto-decide at approval timeout.
      if (jobName === 'auto-decide') {
        await handleAutoDecide(deps, job.data as AutoDecideJob, logger);
        return { ok: true, branch: 'auto-decide' };
      }
      // Tertiary: user tapped approve → execute now.
      if (jobName === 'execute-approved') {
        await executeApproved(deps, (job.data as AutoDecideJob).approvalId, logger);
        return { ok: true, branch: 'execute-approved' };
      }

      // Primary tick: walk eligible users once.
      const configs = await deps.prisma.learningConfig.findMany({
        where: {
          enabled: true,
          autonomyLevel: { in: [AutonomyLevel.GUIDED, AutonomyLevel.SEMI_AUTO, AutonomyLevel.FULL_AUTO] },
        },
      });
      let acted = 0;
      for (const cfg of configs) {
        try {
          const fired = await runForUser(deps, cfg, logger);
          if (fired) acted++;
        } catch (e: any) {
          logger.warn(`user=${cfg.userId} tick failed: ${e.message}`);
        }
      }
      logger.debug(`autonomous tick: ${acted} actions across ${configs.length} users`);
      return { acted };
    }, { traceId: jobTrace });
  });
}

interface AutoDecideJob {
  approvalId: string;
  traceId?: string;
}

async function handleAutoDecide(deps: AutonomousTraderDeps, data: AutoDecideJob, logger: Logger) {
  const req = await deps.prisma.approvalRequest.findUnique({ where: { id: data.approvalId } });
  if (!req) return;
  if (req.status !== ApprovalStatus.PENDING) return; // already resolved
  const cfg = await deps.prisma.learningConfig.findUnique({ where: { userId: req.userId } });
  const onTimeout = cfg?.onTimeout ?? 'reject';
  if (onTimeout === 'reject') {
    await deps.prisma.approvalRequest.update({
      where: { id: req.id },
      data: { status: ApprovalStatus.EXPIRED, respondedAt: new Date() },
    });
    logger.debug(`auto-decide rejected approval=${req.id}`);
    return;
  }
  // onTimeout === 'execute' → run the trade and mark approved.
  await executeApproved(deps, req.id, logger);
}

async function runForUser(deps: AutonomousTraderDeps, cfg: { userId: string; autonomyLevel: AutonomyLevel; maxTradeUsd: number; dailyLimit: number; dailyUsedCount: number; dailyResetAt: Date | null; approvalRequired: boolean; approvalTimeoutMin: number; approvalChannels: ApprovalChannel[] }, logger: Logger) {
  // Daily cap bookkeeping (local helper; no writes here, just read state).
  const { remaining } = dailyCapState(cfg);
  if (remaining <= 0) return false;

  const candidates = await deps.prisma.userStrategy.findMany({
    where: { userId: cfg.userId, enabled: true, score: { gte: MIN_SCORE_TO_ACT } },
    include: { performance: true },
    orderBy: { score: 'desc' },
    take: MAX_CANDIDATES_PER_TICK_PER_USER * 3, // over-fetch to leave room for low-sample filter
  });
  if (!candidates.length) return false;

  // Skip strategies with enough data to judge but poor track record.
  const strategies = candidates.filter((s) => {
    const perf = s.performance;
    if (!perf) return true;
    const score = s.score ?? 0;
    if ((perf.sampleCount ?? 0) >= AUTO_RETIRE_MIN_SAMPLE && score < AUTO_RETIRE_SCORE_FLOOR) return false;
    return true;
  }).slice(0, MAX_CANDIDATES_PER_TICK_PER_USER);
  if (!strategies.length) return false;

  const dnaProfile = await deps.dna.profileForPrompt(cfg.userId);
  let acted = false;

  for (const s of strategies) {
    let episodicBlock: string | undefined;
    if (deps.episodic && process.env.EPISODIC_MEMORY_ENABLED === 'true') {
      try {
        const eps = await deps.episodic.findSimilar(cfg.userId, { rawText: `${s.name} ${(s.definition as any)?.prompt ?? ''}` }, 5);
        if (eps.length) episodicBlock = deps.episodic.compactForPrompt(eps);
      } catch (e: any) {
        logger.debug(`episodic lookup failed strat=${s.id}: ${e.message}`);
      }
    }
    const intent = await proposeIntent(deps.llm, s.name, s.definition, dnaProfile, cfg.maxTradeUsd, episodicBlock);
    if (!intent) continue;

    // L5 conviction capture: score the candidate with the user's weights and
    // persist the breakdown so the learner can correlate factors with outcome.
    let convictionBreakdown: ConvictionBreakdown | undefined;
    if (deps.conviction && deps.tokenIntel) {
      try {
        const intel = await deps.tokenIntel.analyze(intent.chain === 'SOLANA' ? 'SOLANA' : 'EVM' as any, intent.tokenOut);
        convictionBreakdown = await deps.conviction.scoreForUser(cfg.userId, {
          securityScore: intel?.securityScore ?? null,
          holderQuality: null,
          liquidityScore: null,
          sentimentScore: null,
          momentumScore: null,
          riskFlags: (intel?.securityFlags as any) ?? [],
        });
      } catch (e: any) {
        logger.debug(`conviction snapshot failed: ${e.message}`);
      }
    }

    // Enforce the learning-config per-trade cap BEFORE invoking global guardrails.
    if (intent.notionalUsd > cfg.maxTradeUsd) {
      logger.debug(`user=${cfg.userId} strategy=${s.id} proposal exceeds maxTradeUsd; clamping`);
      intent.notionalUsd = cfg.maxTradeUsd;
    }

    // L4: intent rule enforcement runs BEFORE numeric guardrails. Can block,
    // clamp notional, or escalate a FULL_AUTO trade into an ApprovalRequest.
    let intentForceApproval = false;
    if (process.env.INTENT_MEMORY_ENFORCE === 'true' && deps.intentRules && deps.intentEnforcer) {
      const rules = await deps.intentRules.getActive(cfg.userId);
      if (rules.length) {
        const decision = deps.intentEnforcer.check({ intent }, rules);
        if (!decision.ok) {
          logger.debug(`user=${cfg.userId} intent-rule block: ${decision.reason}`);
          await deps.notifications.emit({
            userId: cfg.userId,
            kind: 'INTENT_RULE_BLOCKED',
            payload: { strategyId: s.id, reason: decision.reason, ruleIds: decision.appliedRuleIds, intent },
          });
          if (decision.appliedRuleIds.length) await deps.intentRules.markApplied(decision.appliedRuleIds);
          emitEpisode(cfg.userId, 'REJECTED', intent, { strategyId: s.id, rejectReason: decision.reason }).catch(() => {});
          continue;
        }
        if (decision.adjustedIntent) {
          Object.assign(intent, decision.adjustedIntent);
        }
        if (decision.mustRequireApproval) intentForceApproval = true;
        if (decision.appliedRuleIds.length) await deps.intentRules.markApplied(decision.appliedRuleIds);
      }
    }

    // Guardrails: reuse the same enforcement the manual path uses.
    const decision = await deps.guardrails.check({
      userId: cfg.userId,
      tokenAddress: intent.tokenOut,
      chain: intent.chain === 'SOLANA' ? 'SOLANA' : 'EVM',
      notionalUsd: intent.notionalUsd,
      slippageBps: intent.slippageBps,
    });
    if (!decision.ok) {
      logger.debug(`user=${cfg.userId} guardrail block: ${decision.reason}`);
      emitEpisode(cfg.userId, 'REJECTED', intent, { strategyId: s.id, rejectReason: `guardrail: ${decision.reason}` }).catch(() => {});
      continue;
    }
    const conc = await deps.guardrails.concentrationCheck(cfg.userId, intent.tokenOut, intent.notionalUsd);
    if (!conc.ok) {
      logger.debug(`user=${cfg.userId} concentration block: ${conc.reason}`);
      emitEpisode(cfg.userId, 'REJECTED', intent, { strategyId: s.id, rejectReason: `concentration: ${conc.reason}` }).catch(() => {});
      continue;
    }

    if (cfg.autonomyLevel === AutonomyLevel.GUIDED) {
      await deps.notifications.emit({
        userId: cfg.userId,
        kind: 'STRATEGY_SUGGESTION',
        payload: { strategyId: s.id, strategyName: s.name, intent },
      });
      acted = true;
      continue;
    }

    if (cfg.autonomyLevel === AutonomyLevel.SEMI_AUTO || (cfg.autonomyLevel === AutonomyLevel.FULL_AUTO && cfg.approvalRequired) || intentForceApproval) {
      const intentWithConviction = convictionBreakdown
        ? ({ ...intent, convictionBreakdown } as TradeIntent & { convictionBreakdown: ConvictionBreakdown })
        : intent;
      const req = await deps.approvals.create({
        userId: cfg.userId,
        strategyId: s.id,
        intent: intentWithConviction,
        timeoutMinutes: cfg.approvalTimeoutMin,
        channels: cfg.approvalChannels.length ? cfg.approvalChannels : [ApprovalChannel.WEB],
      });
      // Schedule auto-decide at timeout. BullMQ delayed job survives restarts.
      const q = makeQueue(QUEUES.AUTONOMOUS_TRADER);
      await q.add('auto-decide', { approvalId: req.id }, { delay: cfg.approvalTimeoutMin * 60_000, removeOnComplete: 200, removeOnFail: 100 });
      // L2: record the approval episode with null tradeId so retrieval can
      // learn from "we proposed X and user did/didn't bite".
      emitEpisode(cfg.userId, 'APPROVED', intent, { strategyId: s.id }).catch(() => {});
      acted = true;
      continue;
    }

    // FULL_AUTO with approvalRequired=false → execute inline, account usage.
    try {
      const result = await deps.execution.swap({
        userId: cfg.userId,
        walletId: intent.walletId,
        chain: intent.chain === 'SOLANA' ? 'SOLANA' : 'EVM',
        tokenIn: intent.tokenIn,
        tokenOut: intent.tokenOut,
        amountIn: intent.amountIn,
        notionalUsd: intent.notionalUsd,
        slippageBps: intent.slippageBps,
        strategyId: s.id,
        ...(convictionBreakdown ? { convictionBreakdown: convictionBreakdown as unknown as Record<string, unknown> } : {}),
      });
      await bumpDailyUsage(deps, cfg.userId);
      await deps.notifications.emit({
        userId: cfg.userId,
        kind: 'AUTONOMOUS_TRADE',
        payload: { strategyId: s.id, strategyName: s.name, tradeId: result.tradeId, mode: result.mode, intent },
      });
      acted = true;
    } catch (err: any) {
      logger.warn(`user=${cfg.userId} autonomous exec failed: ${err.message}`);
      await deps.notifications.emit({
        userId: cfg.userId,
        kind: 'AUTONOMOUS_FAILED',
        severity: 'WARN',
        payload: { strategyId: s.id, reason: err.message, intent },
      });
    }
  }
  return acted;
}

// Fire-and-forget episode emit. Intentionally non-typed so call sites don't
// have to know about deps; the worker gates on EPISODIC_MEMORY_ENABLED.
async function emitEpisode(userId: string, kind: 'APPROVED' | 'REJECTED', intent: TradeIntent, extras?: Record<string, unknown>) {
  if (process.env.EPISODIC_MEMORY_ENABLED !== 'true') return;
  try {
    const q = makeQueue(QUEUES.EPISODE_INGEST);
    await q.add(
      'ingest',
      makeJobData({
        userId,
        tradeId: null,
        kind,
        chain: intent.chain === 'SOLANA' ? 'SOLANA' : 'EVM',
        token: intent.tokenOut,
        side: intent.side,
        decisionSeed: { ...extras, notionalUsd: intent.notionalUsd, slippageBps: intent.slippageBps },
        ...(extras?.rejectReason ? { rejectReason: String(extras.rejectReason) } : {}),
      }),
      { removeOnComplete: 200, removeOnFail: 100 },
    );
  } catch {}
}

async function proposeIntent(
  llm: LlmService,
  name: string,
  definition: Prisma.JsonValue,
  dnaProfile: string,
  maxTradeUsd: number,
  episodicBlock?: string,
): Promise<TradeIntent | null> {
  if (process.env.AUTONOMOUS_TRADER_LLM_ENABLED !== 'true') return null;
  const def = (definition ?? {}) as { prompt?: string; notes?: string };
  const system = [
    'You are a trading-decision generator.',
    `Respond ONLY with a single JSON object. If no action is justified right now, respond with {"action":"noop"}.`,
    `Otherwise respond with: {"action":"trade","chain":"SOLANA"|"EVM","tokenIn":"<addr>","tokenOut":"<addr>","amountIn":"<base-units>","notionalUsd":<<=${maxTradeUsd}>,"slippageBps":<integer 50..300>,"side":"buy"|"sell","walletId":"<user primary wallet id>","reason":"<one sentence>"}`,
    'Use tokenIn=USDC/base-stable when buying. Hard-cap notionalUsd at the limit above. Do not output prose or markdown.',
  ].join(' ');
  const user = [
    `Strategy: ${name}`,
    `Rule: ${def.prompt ?? '(no rule)'}`,
    def.notes ? `Notes: ${def.notes}` : '',
    `Trading DNA: ${dnaProfile}`,
    episodicBlock ? `Past similar decisions:\n${episodicBlock}` : '',
  ].filter(Boolean).join('\n');

  let raw: string;
  try {
    raw = await llm.chat([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ]);
  } catch {
    return null;
  }
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (parsed.action !== 'trade') return null;
    const notionalUsd = Number(parsed.notionalUsd);
    if (!Number.isFinite(notionalUsd) || notionalUsd <= 0) return null;
    if (!parsed.tokenIn || !parsed.tokenOut || !parsed.walletId || !parsed.amountIn) return null;
    return {
      chain: String(parsed.chain),
      tokenIn: String(parsed.tokenIn),
      tokenOut: String(parsed.tokenOut),
      amountIn: String(parsed.amountIn),
      notionalUsd,
      slippageBps: Math.max(50, Math.min(300, Number(parsed.slippageBps) || 100)),
      side: parsed.side === 'sell' ? 'sell' : 'buy',
      walletId: String(parsed.walletId),
      reason: String(parsed.reason ?? ''),
    };
  } catch {
    return null;
  }
}

function dailyCapState(cfg: { dailyLimit: number; dailyUsedCount: number; dailyResetAt: Date | null }) {
  const now = Date.now();
  const resetExpired = !cfg.dailyResetAt || cfg.dailyResetAt.getTime() < now;
  const used = resetExpired ? 0 : cfg.dailyUsedCount;
  return { used, remaining: cfg.dailyLimit - used, resetExpired };
}

async function bumpDailyUsage(deps: AutonomousTraderDeps, userId: string) {
  const cfg = await deps.prisma.learningConfig.findUnique({ where: { userId } });
  if (!cfg) return;
  const { resetExpired } = dailyCapState(cfg);
  await deps.prisma.learningConfig.update({
    where: { userId },
    data: resetExpired
      ? { dailyUsedCount: 1, dailyResetAt: new Date(Date.now() + 24 * 3600_000) }
      : { dailyUsedCount: { increment: 1 } },
  });
}

async function executeApproved(deps: AutonomousTraderDeps, approvalId: string, logger: Logger) {
  const req = await deps.prisma.approvalRequest.findUnique({ where: { id: approvalId } });
  if (!req) return;
  const intent = req.tradeIntent as unknown as TradeIntent & { executedTradeId?: string };
  if (intent.executedTradeId) {
    logger.debug(`approval=${approvalId} already executed trade=${intent.executedTradeId}`);
    return;
  }
  try {
    const breakdown = (intent as any).convictionBreakdown as Record<string, unknown> | undefined;
    const result = await deps.execution.swap({
      userId: req.userId,
      walletId: intent.walletId,
      chain: intent.chain === 'SOLANA' ? 'SOLANA' : 'EVM',
      tokenIn: intent.tokenIn,
      tokenOut: intent.tokenOut,
      amountIn: intent.amountIn,
      notionalUsd: intent.notionalUsd,
      slippageBps: intent.slippageBps,
      ...(req.strategyId ? { strategyId: req.strategyId } : {}),
      ...(breakdown ? { convictionBreakdown: breakdown } : {}),
    });
    const nextIntent = { ...intent, executedTradeId: result.tradeId };
    await deps.prisma.approvalRequest.update({
      where: { id: approvalId },
      data: {
        status: ApprovalStatus.APPROVED,
        respondedAt: new Date(),
        tradeIntent: nextIntent as unknown as Prisma.InputJsonValue,
      },
    });
    await bumpDailyUsage(deps, req.userId);
    await deps.notifications.emit({
      userId: req.userId,
      kind: 'AUTONOMOUS_TRADE',
      payload: { approvalId, tradeId: result.tradeId, mode: result.mode, via: 'TIMEOUT_EXECUTE' },
    });
  } catch (err: any) {
    logger.warn(`approval=${approvalId} execute failed: ${err.message}`);
    await deps.notifications.emit({
      userId: req.userId,
      kind: 'AUTONOMOUS_FAILED',
      severity: 'WARN',
      payload: { approvalId, reason: err.message },
    });
  }
}
