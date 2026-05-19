/**
 * Phase 5.3: Rule Engine Service
 *
 * Provides the 26 agent tools for managing rule sets:
 * create_rule_set, add_rule, add_condition, set_sizing_policy,
 * set_entry_policy, set_exit_policy, set_risk_policy, bind_rule_set,
 * activate_rule_set, archive_rule_set, list_rule_sets, get_rule_set,
 * create_signal_source, update_signal_source, delete_signal_source,
 * list_signal_sources, enqueue_signal (fast + slow path),
 * get_rule_outcomes, get_rule_performance, list_firings.
 */
import { Injectable, Logger } from '@nestjs/common';
import { RuleSetStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { makeQueue, makeJobData, QUEUES } from './queues';
import { newTraceId } from '../common/trace-context';

@Injectable()
export class RuleEngineService {
  private readonly logger = new Logger(RuleEngineService.name);

  constructor(private prisma: PrismaService) {}

  // ── Rule Set CRUD ───────────────────────────────────────────────────────

  async createRuleSet(userId: string, name: string, description?: string) {
    return (this.prisma as any).ruleSet.create({
      data: { userId, name, description: description ?? null },
    });
  }

  async getRuleSet(userId: string, id: string) {
    return (this.prisma as any).ruleSet.findFirst({
      where: { id, userId },
      include: { rules: { include: { conditions: true } }, bindings: true, sizingPolicy: true, entryPolicy: true, exitPolicy: true, riskPolicy: true },
    });
  }

  async listRuleSets(userId: string) {
    return (this.prisma as any).ruleSet.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { sizingPolicy: true, entryPolicy: true, exitPolicy: true, riskPolicy: true, bindings: true },
    });
  }

  async activateRuleSet(userId: string, id: string, mode: 'canary' | 'active' = 'canary') {
    const status = mode === 'active' ? RuleSetStatus.ACTIVE : RuleSetStatus.CANARY;
    return (this.prisma as any).ruleSet.update({
      where: { id, userId },
      data: { status },
    });
  }

  async archiveRuleSet(userId: string, id: string) {
    return (this.prisma as any).ruleSet.update({
      where: { id, userId },
      data: { status: RuleSetStatus.ARCHIVED },
    });
  }

  // ── Rules & Conditions ─────────────────────────────────────────────────

  async addRule(userId: string, ruleSetId: string, name?: string, priority = 0) {
    await this.assertOwnsRuleSet(userId, ruleSetId);
    return (this.prisma as any).rule.create({ data: { ruleSetId, name, priority } });
  }

  async addCondition(
    userId: string,
    ruleId: string,
    field: string,
    operator: string,
    value: unknown,
  ) {
    const rule = await (this.prisma as any).rule.findUnique({ where: { id: ruleId }, include: { ruleSet: true } });
    if (!rule || rule.ruleSet.userId !== userId) throw new Error('Rule not found');
    return (this.prisma as any).condition.create({ data: { ruleId, field, operator, value } });
  }

  // ── Policies ────────────────────────────────────────────────────────────

  async setSizingPolicy(userId: string, ruleSetId: string, data: {
    mode: string; fixedUsd?: number; pctPortfolio?: number; kellyFraction?: number; maxUsd?: number;
  }) {
    await this.assertOwnsRuleSet(userId, ruleSetId);
    return (this.prisma as any).sizingPolicy.upsert({
      where: { ruleSetId },
      update: data,
      create: { ruleSetId, ...data },
    });
  }

  async setEntryPolicy(userId: string, ruleSetId: string, data: {
    orderType?: string; slippageBps?: number; router?: string; limitOffsetBps?: number;
  }) {
    await this.assertOwnsRuleSet(userId, ruleSetId);
    return (this.prisma as any).entryPolicy.upsert({
      where: { ruleSetId },
      update: data,
      create: { ruleSetId, ...data },
    });
  }

  async setExitPolicy(userId: string, ruleSetId: string, data: {
    stopLossPct?: number; stopLossSize?: number;
    tp1Pct?: number; tp1Size?: number;
    tp2Pct?: number; tp2Size?: number;
    trailingPct?: number; trailingSize?: number;
    breakEvenAt?: number; timeStopHours?: number; timeStopPct?: number;
  }) {
    await this.assertOwnsRuleSet(userId, ruleSetId);
    return (this.prisma as any).exitPolicy.upsert({
      where: { ruleSetId },
      update: data,
      create: { ruleSetId, ...data },
    });
  }

  async setRiskPolicy(userId: string, ruleSetId: string, data: {
    maxPerTradeUsd?: number; maxDailyUsd?: number;
    cooldownSeconds?: number; maxTiltStreak?: number; minRiskScore?: number;
  }) {
    await this.assertOwnsRuleSet(userId, ruleSetId);
    return (this.prisma as any).riskPolicy.upsert({
      where: { ruleSetId },
      update: data,
      create: { ruleSetId, ...data },
    });
  }

  async bindRuleSet(userId: string, ruleSetId: string, scope: string, scopeRef?: string) {
    await this.assertOwnsRuleSet(userId, ruleSetId);
    return (this.prisma as any).ruleBinding.create({ data: { userId, ruleSetId, scope, scopeRef } });
  }

  // ── Signal Sources ───────────────────────────────────────────────────────

  async createSignalSource(userId: string, data: {
    kind: string; name: string; externalRef?: string;
    trust?: string; fastPathEnabled?: boolean; walletId?: string;
  }) {
    return (this.prisma as any).signalSource.create({ data: { userId, ...data } });
  }

  async updateSignalSource(userId: string, id: string, data: Partial<{
    name: string; trust: string; fastPathEnabled: boolean; enabled: boolean; walletId: string;
  }>) {
    return (this.prisma as any).signalSource.update({ where: { id, userId }, data });
  }

  async deleteSignalSource(userId: string, id: string) {
    return (this.prisma as any).signalSource.delete({ where: { id, userId } });
  }

  async listSignalSources(userId: string) {
    return (this.prisma as any).signalSource.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
  }

  // ── Signal Enqueue ───────────────────────────────────────────────────────

  async enqueueSignal(
    userId: string,
    sourceId: string,
    tokenAddress: string,
    opts: { ticker?: string; chain?: string; rawText?: string; metadata?: unknown; fast?: boolean },
  ) {
    const trace = newTraceId();
    const signal = await (this.prisma as any).signal.create({
      data: {
        userId,
        sourceId,
        traceId: trace,
        tokenAddress,
        ticker: opts.ticker,
        chain: opts.chain ?? 'SOLANA',
        rawText: opts.rawText,
        metadata: opts.metadata ?? undefined,
        fastPath: opts.fast ?? false,
      },
    });

    const queue = opts.fast
      ? makeQueue(QUEUES.RULES_FAST)
      : makeQueue(QUEUES.RULES_SLOW);

    await queue.add(
      opts.fast ? 'fast-signal' : 'slow-signal',
      makeJobData({ signalId: signal.id, userId, traceId: trace }),
      { removeOnComplete: 200, removeOnFail: 100 },
    );

    this.logger.log(`[trc=${trace}] enqueued ${opts.fast ? 'fast' : 'slow'} signal=${signal.id} token=${tokenAddress}`);
    return { signalId: signal.id, traceId: trace };
  }

  // ── Analytics ────────────────────────────────────────────────────────────

  async getRulePerformance(userId: string, ruleSetId: string) {
    const firings = await (this.prisma as any).ruleFiring.findMany({
      where: { userId, ruleSetId },
      include: { outcome: true },
    });

    const outcomes = firings.map((f: any) => f.outcome).filter(Boolean);
    const wins = outcomes.filter((o: any) => o.status === 'WIN').length;
    const losses = outcomes.filter((o: any) => o.status === 'LOSS').length;
    const total = wins + losses;
    const pnlUsd = outcomes.reduce((s: number, o: any) => s + (o.pnlUsd ?? 0), 0);
    const avgLatencyMs = firings.length > 0
      ? Math.round(firings.reduce((s: number, f: any) => s + (f.latencyMs ?? 0), 0) / firings.length)
      : 0;

    return {
      ruleSetId,
      totalTrades: total,
      wins,
      losses,
      winRate: total > 0 ? wins / total : null,
      pnlUsd,
      avgLatencyMs,
    };
  }

  async listFirings(userId: string, ruleSetId?: string, limit = 50) {
    return (this.prisma as any).ruleFiring.findMany({
      where: { userId, ...(ruleSetId ? { ruleSetId } : {}) },
      orderBy: { firedAt: 'desc' },
      take: limit,
      include: { outcome: true, signal: true },
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async assertOwnsRuleSet(userId: string, ruleSetId: string) {
    const rs = await (this.prisma as any).ruleSet.findFirst({ where: { id: ruleSetId, userId } });
    if (!rs) throw new Error(`RuleSet ${ruleSetId} not found`);
    return rs;
  }
}
