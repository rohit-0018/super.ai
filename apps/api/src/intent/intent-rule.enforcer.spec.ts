import { IntentRuleEnforcer } from './intent-rule.enforcer';
import { IntentScope, IntentStatus, IntentSource, UserIntentRule } from '@prisma/client';
import { TradeIntent } from '../approvals/approvals.service';
import { IntentRuleDsl } from './intent-rule.dsl';

function rule(over: Partial<UserIntentRule> & { rule: IntentRuleDsl; scope: IntentScope }): UserIntentRule {
  return {
    id: over.id ?? 'r1',
    userId: 'u1',
    text: over.text ?? 'rule',
    rule: over.rule as any,
    source: over.source ?? IntentSource.MANUAL,
    scope: over.scope,
    status: over.status ?? IntentStatus.ACTIVE,
    priority: over.priority ?? 50,
    confidence: over.confidence ?? 1,
    lastAppliedAt: over.lastAppliedAt ?? null,
    retiredReason: null,
    sourceApprovalId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const baseIntent: TradeIntent = {
  chain: 'SOLANA',
  tokenIn: 'USDC',
  tokenOut: 'DOGE',
  amountIn: '100',
  notionalUsd: 100,
  slippageBps: 100,
  side: 'buy',
  walletId: 'w1',
  reason: 'test',
};

describe('IntentRuleEnforcer', () => {
  const enforcer = new IntentRuleEnforcer();

  it('blocks on a matching blocklist rule', () => {
    const r = rule({ rule: { kind: 'block', token: 'doge' }, scope: IntentScope.BLOCKLIST });
    const out = enforcer.check({ intent: baseIntent }, [r]);
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('Blocked by rule');
    expect(out.appliedRuleIds).toEqual(['r1']);
  });

  it('fails a require rule when mcap below threshold', () => {
    const r = rule({ rule: { kind: 'require', min_mcap_usd: 10_000_000 }, scope: IntentScope.ALLOWLIST });
    const out = enforcer.check({ intent: baseIntent, meta: { mcapUsd: 100_000 } }, [r]);
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/min_mcap_usd/);
  });

  it('clamps notional on max_size_usd per=trade', () => {
    const r = rule({ rule: { kind: 'max_size_usd', value: 50, per: 'trade' }, scope: IntentScope.SIZING });
    const out = enforcer.check({ intent: { ...baseIntent, notionalUsd: 200 } }, [r]);
    expect(out.ok).toBe(true);
    expect(out.adjustedIntent?.notionalUsd).toBe(50);
    expect(out.appliedRuleIds).toEqual(['r1']);
  });

  it('rejects when per=day usage would overflow', () => {
    const r = rule({ rule: { kind: 'max_size_usd', value: 100, per: 'day' }, scope: IntentScope.SIZING });
    const out = enforcer.check({ intent: baseIntent, usage: { dailyUsd: 80 } }, [r]);
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/daily cap/);
  });

  it('escalates (mustRequireApproval) without blocking', () => {
    const r = rule({
      rule: { kind: 'require_approval_if', condition: { notional_usd_gt: 50 } },
      scope: IntentScope.RISK,
    });
    const out = enforcer.check({ intent: baseIntent }, [r]);
    expect(out.ok).toBe(true);
    expect(out.mustRequireApproval).toBe(true);
  });

  it('blocks outside an allow_utc_hours window', () => {
    const other = (new Date().getUTCHours() + 12) % 24;
    const r = rule({
      rule: { kind: 'time_window', allow_utc_hours: [other] },
      scope: IntentScope.TIMING,
    });
    const out = enforcer.check({ intent: baseIntent }, [r]);
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/allowed hours/);
  });

  it('fail-fast ordering: block beats require beats sizing', () => {
    const rules = [
      rule({ id: 'a', rule: { kind: 'max_size_usd', value: 50, per: 'trade' }, scope: IntentScope.SIZING }),
      rule({ id: 'b', rule: { kind: 'block', token: 'doge' }, scope: IntentScope.BLOCKLIST }),
    ];
    const out = enforcer.check({ intent: baseIntent }, rules);
    expect(out.ok).toBe(false);
    expect(out.appliedRuleIds).toEqual(['b']);
    expect(out.adjustedIntent).toBeUndefined();
  });
});
