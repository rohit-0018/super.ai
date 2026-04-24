import { Injectable } from '@nestjs/common';
import { UserIntentRule } from '@prisma/client';
import { IntentRuleDsl } from './intent-rule.dsl';
import { TradeIntent } from '../approvals/approvals.service';

export interface EnforcerDecision {
  ok: boolean;
  reason?: string;
  appliedRuleIds: string[];
  mustRequireApproval: boolean;
  adjustedIntent?: TradeIntent;
}

export interface EnforcerCandidate {
  intent: TradeIntent;
  // Optional token metadata to let `require`/`block` match on asset class.
  meta?: { assetClass?: string; symbol?: string; mcapUsd?: number; liquidityUsd?: number; holders?: number; hasAudit?: boolean };
  // Optional counts for `max_size_usd` per=day / per=token.
  usage?: { dailyUsd?: number; perTokenUsd?: number };
}

@Injectable()
export class IntentRuleEnforcer {
  check(candidate: EnforcerCandidate, rules: UserIntentRule[]): EnforcerDecision {
    let adjusted: TradeIntent | undefined;
    const applied: string[] = [];
    let mustRequireApproval = false;

    const intent = { ...candidate.intent };
    const nowUtcHour = new Date().getUTCHours();
    const nowDay = new Date().getUTCDay();

    // 1. BLOCKLIST pass — any hit fails fast.
    for (const r of rules) {
      const dsl = r.rule as unknown as IntentRuleDsl;
      if (dsl.kind !== 'block') continue;
      if (blockMatches(dsl, intent, candidate.meta)) {
        applied.push(r.id);
        return { ok: false, reason: `Blocked by rule: ${r.text}`, appliedRuleIds: applied, mustRequireApproval: false };
      }
    }

    // 2. ALLOWLIST / require — any require-rule that fails fails fast.
    for (const r of rules) {
      const dsl = r.rule as unknown as IntentRuleDsl;
      if (dsl.kind !== 'require') continue;
      const fail = requireFails(dsl, intent, candidate.meta);
      if (fail) {
        applied.push(r.id);
        return { ok: false, reason: `Requirement unmet: ${fail} (${r.text})`, appliedRuleIds: applied, mustRequireApproval: false };
      }
      applied.push(r.id);
    }

    // 3. TIMING.
    for (const r of rules) {
      const dsl = r.rule as unknown as IntentRuleDsl;
      if (dsl.kind !== 'time_window') continue;
      if (dsl.allow_utc_hours?.length && !dsl.allow_utc_hours.includes(nowUtcHour)) {
        applied.push(r.id);
        return { ok: false, reason: `Outside allowed hours: ${r.text}`, appliedRuleIds: applied, mustRequireApproval: false };
      }
      if (dsl.block_utc_hours?.includes(nowUtcHour)) {
        applied.push(r.id);
        return { ok: false, reason: `Blocked hour: ${r.text}`, appliedRuleIds: applied, mustRequireApproval: false };
      }
      if (dsl.days_of_week?.length && !dsl.days_of_week.includes(nowDay)) {
        applied.push(r.id);
        return { ok: false, reason: `Blocked day: ${r.text}`, appliedRuleIds: applied, mustRequireApproval: false };
      }
      applied.push(r.id);
    }

    // 4. SIZING — clamp or reject.
    for (const r of rules) {
      const dsl = r.rule as unknown as IntentRuleDsl;
      if (dsl.kind !== 'max_size_usd') continue;
      const per = dsl.per ?? 'trade';
      if (per === 'trade') {
        if (intent.notionalUsd > dsl.value) {
          intent.notionalUsd = dsl.value;
          adjusted = { ...intent };
        }
        applied.push(r.id);
      } else if (per === 'day') {
        const dailyUsed = candidate.usage?.dailyUsd ?? 0;
        if (dailyUsed + intent.notionalUsd > dsl.value) {
          applied.push(r.id);
          return { ok: false, reason: `Exceeds daily cap: ${r.text}`, appliedRuleIds: applied, mustRequireApproval: false };
        }
        applied.push(r.id);
      } else if (per === 'token') {
        const tokenUsed = candidate.usage?.perTokenUsd ?? 0;
        if (tokenUsed + intent.notionalUsd > dsl.value) {
          applied.push(r.id);
          return { ok: false, reason: `Exceeds per-token cap: ${r.text}`, appliedRuleIds: applied, mustRequireApproval: false };
        }
        applied.push(r.id);
      }
    }

    // 5. REQUIRE_APPROVAL_IF — escalate, never block.
    for (const r of rules) {
      const dsl = r.rule as unknown as IntentRuleDsl;
      if (dsl.kind !== 'require_approval_if') continue;
      const c = dsl.condition;
      if (
        (c.notional_usd_gt != null && intent.notionalUsd > c.notional_usd_gt) ||
        (c.slippage_bps_gt != null && intent.slippageBps > c.slippage_bps_gt) ||
        (c.new_token === true)
      ) {
        mustRequireApproval = true;
        applied.push(r.id);
      }
    }

    return { ok: true, appliedRuleIds: applied, mustRequireApproval, adjustedIntent: adjusted };
  }
}

function blockMatches(
  dsl: Extract<IntentRuleDsl, { kind: 'block' }>,
  intent: TradeIntent,
  meta?: EnforcerCandidate['meta'],
): boolean {
  if (dsl.token && intent.tokenOut.toLowerCase() === dsl.token.toLowerCase()) return true;
  if (dsl.chain && intent.chain.toUpperCase() === dsl.chain.toUpperCase() && !dsl.token && !dsl.asset_class && !dsl.symbol_pattern) return true;
  if (dsl.asset_class && meta?.assetClass && meta.assetClass.toLowerCase() === dsl.asset_class.toLowerCase()) return true;
  if (dsl.symbol_pattern && meta?.symbol && new RegExp(dsl.symbol_pattern, 'i').test(meta.symbol)) return true;
  return false;
}

function requireFails(
  dsl: Extract<IntentRuleDsl, { kind: 'require' }>,
  intent: TradeIntent,
  meta?: EnforcerCandidate['meta'],
): string | null {
  if (dsl.chain && intent.chain.toUpperCase() !== dsl.chain.toUpperCase()) return 'chain';
  if (dsl.min_mcap_usd != null && (meta?.mcapUsd ?? 0) < dsl.min_mcap_usd) return 'min_mcap_usd';
  if (dsl.min_liquidity_usd != null && (meta?.liquidityUsd ?? 0) < dsl.min_liquidity_usd) return 'min_liquidity_usd';
  if (dsl.min_holders != null && (meta?.holders ?? 0) < dsl.min_holders) return 'min_holders';
  if (dsl.must_have_audit && !meta?.hasAudit) return 'must_have_audit';
  return null;
}
