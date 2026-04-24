import { Injectable, Logger } from '@nestjs/common';
import { IntentScope, IntentSource } from '@prisma/client';
import { LlmService } from '../ai-agent/llm.service';
import { IntentRuleDsl, validateIntentRuleDsl } from './intent-rule.dsl';
import { IntentRuleService } from './intent-rule.service';

const SYSTEM_PROMPT = [
  'You extract durable trading rules from one-off chat / trade-rejection events.',
  'Output ONLY JSON: an array of 0..3 objects of shape',
  '{"text": string, "rule": object, "scope": "BLOCKLIST"|"ALLOWLIST"|"SIZING"|"TIMING"|"RISK"|"PREFERENCE", "confidence": 0..1}.',
  'Rule DSL is a discriminated union on `kind`:',
  '  - {"kind":"block", "asset_class"?, "chain"?, "token"?, "symbol_pattern"?}',
  '  - {"kind":"require", "min_mcap_usd"?, "min_liquidity_usd"?, "min_holders"?, "chain"?, "must_have_audit"?}',
  '  - {"kind":"time_window", "allow_utc_hours"?:number[], "block_utc_hours"?:number[], "days_of_week"?:number[]}',
  '  - {"kind":"max_size_usd", "value":number, "per":"trade"|"day"|"token"}',
  '  - {"kind":"require_approval_if", "condition":{"notional_usd_gt"?,"slippage_bps_gt"?,"new_token"?}}',
  '  - {"kind":"prefer", "asset_class"?, "chain"?, "weight"?}',
  'Return [] if the event is not expressing a durable rule (questions, one-off trades, chit-chat).',
  'Confidence ≥ 0.9 only for explicit never/always/max; 0.7-0.9 for "prefer"/"usually"; <0.7 for ambiguous.',
  'Never output markdown fences or prose outside the JSON array.',
].join(' ');

export interface ExtractedRule {
  text: string;
  rule: IntentRuleDsl;
  scope: IntentScope;
  confidence: number;
}

@Injectable()
export class IntentExtractorService {
  private readonly logger = new Logger(IntentExtractorService.name);

  constructor(
    private llm: LlmService,
    private rules: IntentRuleService,
  ) {}

  async extractFromChat(userId: string, userMsg: string, assistantReply: string): Promise<ExtractedRule[]> {
    if (userMsg.length < 8 || userMsg.startsWith('/')) return [];
    const user = [
      `User said: "${userMsg.slice(0, 2000)}"`,
      `Assistant replied: "${assistantReply.slice(0, 2000)}"`,
      'Extract rules the user stated that should persist across sessions.',
    ].join('\n');
    return this.runExtract(userId, user, IntentSource.CHAT);
  }

  async extractFromRejection(
    userId: string,
    approval: { tradeIntent: unknown; rejectCategory?: string | null; rejectReason?: string | null; id?: string },
  ): Promise<ExtractedRule[]> {
    const user = [
      `The user rejected an autonomous trade.`,
      `Trade intent: ${JSON.stringify(approval.tradeIntent).slice(0, 1500)}`,
      approval.rejectCategory ? `Category: ${approval.rejectCategory}` : '',
      approval.rejectReason ? `Reason: ${approval.rejectReason.slice(0, 400)}` : '',
      'If the rejection implies a durable rule (never this asset class, cap sizes, etc) extract it.',
    ].filter(Boolean).join('\n');
    return this.runExtract(userId, user, IntentSource.REJECTION, approval.id);
  }

  private async runExtract(
    userId: string,
    user: string,
    source: IntentSource,
    sourceApprovalId?: string,
  ): Promise<ExtractedRule[]> {
    let raw: string;
    try {
      raw = await this.llm.chat([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: user },
      ]);
    } catch (e: any) {
      this.logger.warn(`extract user=${userId} llm failed: ${e.message}`);
      return [];
    }
    const arr = parseJsonArray(raw);
    if (!arr) return [];
    const out: ExtractedRule[] = [];
    for (const item of arr) {
      try {
        const text = String(item.text ?? '').trim();
        if (!text) continue;
        const rule = validateIntentRuleDsl(item.rule);
        const scope = normalizeScope(item.scope, rule);
        const confidence = Math.max(0, Math.min(1, Number(item.confidence) || 0));
        out.push({ text: text.slice(0, 400), rule, scope, confidence });
      } catch (err: any) {
        this.logger.debug(`skip invalid extracted rule: ${err.message}`);
      }
    }
    // Propose (dedupe internal).
    for (const r of out) {
      try {
        await this.rules.propose(userId, { ...r, source, sourceApprovalId });
      } catch (err: any) {
        this.logger.warn(`propose failed user=${userId}: ${err.message}`);
      }
    }
    return out;
  }
}

function parseJsonArray(raw: string): any[] | null {
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeScope(raw: unknown, rule: IntentRuleDsl): IntentScope {
  const upper = typeof raw === 'string' ? raw.toUpperCase() : '';
  if (upper === 'BLOCKLIST' || upper === 'ALLOWLIST' || upper === 'SIZING' || upper === 'TIMING' || upper === 'RISK' || upper === 'PREFERENCE') {
    return upper as IntentScope;
  }
  switch (rule.kind) {
    case 'block': return IntentScope.BLOCKLIST;
    case 'require': return IntentScope.ALLOWLIST;
    case 'time_window': return IntentScope.TIMING;
    case 'max_size_usd': return IntentScope.SIZING;
    case 'require_approval_if': return IntentScope.RISK;
    case 'prefer': return IntentScope.PREFERENCE;
  }
}
