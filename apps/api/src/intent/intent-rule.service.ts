import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { IntentScope, IntentSource, IntentStatus, Prisma, UserIntentRule } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { IntentRuleDsl, validateIntentRuleDsl } from './intent-rule.dsl';

const ACTIVE_CACHE_TTL_MS = 60_000;

export interface ProposeInput {
  text: string;
  rule: IntentRuleDsl;
  source: IntentSource;
  scope: IntentScope;
  confidence: number;
  priority?: number;
  sourceApprovalId?: string;
}

export interface ProposeResult {
  kind: 'created' | 'merged';
  rule: UserIntentRule;
}

@Injectable()
export class IntentRuleService {
  private readonly logger = new Logger(IntentRuleService.name);
  private activeCache = new Map<string, { rules: UserIntentRule[]; ts: number }>();

  constructor(private prisma: PrismaService) {}

  async getActive(userId: string, scope?: IntentScope): Promise<UserIntentRule[]> {
    const cached = this.activeCache.get(userId);
    if (cached && Date.now() - cached.ts < ACTIVE_CACHE_TTL_MS) {
      return scope ? cached.rules.filter((r) => r.scope === scope) : cached.rules;
    }
    const rules = await this.prisma.userIntentRule.findMany({
      where: { userId, status: IntentStatus.ACTIVE },
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
    });
    this.activeCache.set(userId, { rules, ts: Date.now() });
    return scope ? rules.filter((r) => r.scope === scope) : rules;
  }

  async getForPrompt(userId: string, limit = 20): Promise<string[]> {
    const rules = await this.getActive(userId);
    return rules.slice(0, limit).map((r) => r.text);
  }

  async listAll(userId: string) {
    return this.prisma.userIntentRule.findMany({
      where: { userId, status: { not: IntentStatus.RETIRED } },
      orderBy: [{ status: 'asc' }, { priority: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async propose(userId: string, input: ProposeInput): Promise<ProposeResult> {
    const rule = validateIntentRuleDsl(input.rule);
    const confidence = Math.max(0, Math.min(1, input.confidence));
    const priority = Math.max(0, Math.min(100, input.priority ?? 50));
    const duplicate = await this.findDuplicate(userId, rule, input.scope);
    if (duplicate) {
      const merged = await this.prisma.userIntentRule.update({
        where: { id: duplicate.id },
        data: {
          confidence: Math.max(duplicate.confidence, confidence),
          lastAppliedAt: duplicate.lastAppliedAt,
        },
      });
      this.invalidate(userId);
      return { kind: 'merged', rule: merged };
    }
    const status = confidence >= 0.7 && input.source !== IntentSource.CHAT ? IntentStatus.ACTIVE
      : confidence >= 0.7 ? IntentStatus.ACTIVE // CHAT-sourced rules above confidence threshold still ACTIVE, but cap priority lower
      : IntentStatus.PROPOSED;
    const created = await this.prisma.userIntentRule.create({
      data: {
        userId,
        text: input.text.slice(0, 400),
        rule: rule as unknown as Prisma.InputJsonValue,
        source: input.source,
        scope: input.scope,
        status,
        priority: input.source === IntentSource.CHAT ? Math.min(priority, 70) : priority,
        confidence,
        sourceApprovalId: input.sourceApprovalId,
      },
    });
    this.invalidate(userId);
    return { kind: 'created', rule: created };
  }

  async updateStatus(userId: string, id: string, status: IntentStatus, reason?: string) {
    const existing = await this.prisma.userIntentRule.findUnique({ where: { id } });
    if (!existing || existing.userId !== userId) throw new NotFoundException();
    const out = await this.prisma.userIntentRule.update({
      where: { id },
      data: {
        status,
        ...(status === IntentStatus.RETIRED ? { retiredReason: reason ?? 'USER_ACTION' } : {}),
      },
    });
    this.invalidate(userId);
    return out;
  }

  async update(userId: string, id: string, patch: { text?: string; rule?: IntentRuleDsl; scope?: IntentScope; priority?: number }) {
    const existing = await this.prisma.userIntentRule.findUnique({ where: { id } });
    if (!existing || existing.userId !== userId) throw new NotFoundException();
    const data: Prisma.UserIntentRuleUpdateInput = {};
    if (patch.text !== undefined) data.text = patch.text.slice(0, 400);
    if (patch.rule !== undefined) data.rule = validateIntentRuleDsl(patch.rule) as unknown as Prisma.InputJsonValue;
    if (patch.scope !== undefined) data.scope = patch.scope;
    if (patch.priority !== undefined) data.priority = Math.max(0, Math.min(100, patch.priority));
    const out = await this.prisma.userIntentRule.update({ where: { id }, data });
    this.invalidate(userId);
    return out;
  }

  async markApplied(ruleIds: string[]) {
    if (!ruleIds.length) return;
    await this.prisma.userIntentRule.updateMany({
      where: { id: { in: ruleIds } },
      data: { lastAppliedAt: new Date() },
    });
  }

  invalidate(userId: string) {
    this.activeCache.delete(userId);
  }

  // Dedupe on (userId, rule.kind, key shape). Cheap heuristic — not a full
  // semantic equality check.
  private async findDuplicate(userId: string, rule: IntentRuleDsl, scope: IntentScope): Promise<UserIntentRule | null> {
    const candidates = await this.prisma.userIntentRule.findMany({
      where: { userId, scope, status: { in: [IntentStatus.ACTIVE, IntentStatus.PROPOSED] } },
    });
    for (const c of candidates) {
      const existing = c.rule as unknown as IntentRuleDsl;
      if (existing.kind !== rule.kind) continue;
      if (existing.kind === 'block' && rule.kind === 'block') {
        if ((existing.token ?? '') === (rule.token ?? '') && (existing.asset_class ?? '') === (rule.asset_class ?? '') && (existing.chain ?? '') === (rule.chain ?? '')) return c;
      } else if (existing.kind === 'max_size_usd' && rule.kind === 'max_size_usd') {
        if ((existing.per ?? 'trade') === (rule.per ?? 'trade')) return c;
      } else if (existing.kind === 'require' && rule.kind === 'require') {
        if ((existing.chain ?? '') === (rule.chain ?? '')) return c;
      } else if (existing.kind === 'time_window' && rule.kind === 'time_window') {
        return c;
      } else if (existing.kind === rule.kind) {
        return c;
      }
    }
    return null;
  }
}
