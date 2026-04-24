// DSL schema for UserIntentRule.rule. Stored as JSON; validated at the
// service layer on every write. Each rule is a discriminated union on `kind`.

export type IntentRuleDsl =
  | { kind: 'block'; asset_class?: string; chain?: string; token?: string; symbol_pattern?: string }
  | { kind: 'require'; min_mcap_usd?: number; min_liquidity_usd?: number; min_holders?: number; chain?: string; must_have_audit?: boolean }
  | { kind: 'time_window'; allow_utc_hours?: number[]; block_utc_hours?: number[]; days_of_week?: number[] }
  | { kind: 'max_size_usd'; value: number; per?: 'trade' | 'day' | 'token' }
  | { kind: 'require_approval_if'; condition: { notional_usd_gt?: number; slippage_bps_gt?: number; new_token?: boolean } }
  | { kind: 'prefer'; asset_class?: string; chain?: string; weight?: number };

// Returns a normalised/validated copy or throws. Keeps the parsed field set
// tight so a hostile / hallucinated payload can't smuggle extra keys into
// storage.
export function validateIntentRuleDsl(raw: unknown): IntentRuleDsl {
  if (!raw || typeof raw !== 'object') throw new Error('rule must be an object');
  const r = raw as Record<string, unknown>;
  const kind = r.kind;
  if (typeof kind !== 'string') throw new Error('rule.kind is required');

  const finite = (v: unknown): number | undefined => {
    if (v == null) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length ? v : undefined);
  const strArr = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x) => typeof x === 'string') : undefined;
  const numArr = (v: unknown): number[] | undefined =>
    Array.isArray(v) ? v.map(Number).filter((n) => Number.isFinite(n)) : undefined;

  switch (kind) {
    case 'block':
      return {
        kind: 'block',
        asset_class: str(r.asset_class)?.toLowerCase(),
        chain: str(r.chain)?.toUpperCase(),
        token: str(r.token)?.toLowerCase(),
        symbol_pattern: str(r.symbol_pattern)?.toUpperCase(),
      };
    case 'require':
      return {
        kind: 'require',
        min_mcap_usd: finite(r.min_mcap_usd),
        min_liquidity_usd: finite(r.min_liquidity_usd),
        min_holders: finite(r.min_holders),
        chain: str(r.chain)?.toUpperCase(),
        must_have_audit: r.must_have_audit === true,
      };
    case 'time_window':
      return {
        kind: 'time_window',
        allow_utc_hours: numArr(r.allow_utc_hours),
        block_utc_hours: numArr(r.block_utc_hours),
        days_of_week: numArr(r.days_of_week),
      };
    case 'max_size_usd': {
      const value = finite(r.value);
      if (value == null || value <= 0) throw new Error('max_size_usd.value must be positive');
      const per = str(r.per);
      return { kind: 'max_size_usd', value, per: per === 'day' || per === 'token' ? per : 'trade' };
    }
    case 'require_approval_if': {
      const c = (r.condition && typeof r.condition === 'object' ? (r.condition as Record<string, unknown>) : {});
      return {
        kind: 'require_approval_if',
        condition: {
          notional_usd_gt: finite(c.notional_usd_gt),
          slippage_bps_gt: finite(c.slippage_bps_gt),
          new_token: c.new_token === true,
        },
      };
    }
    case 'prefer':
      return {
        kind: 'prefer',
        asset_class: str(r.asset_class)?.toLowerCase(),
        chain: str(r.chain)?.toUpperCase(),
        weight: finite(r.weight),
      };
    default:
      throw new Error(`unknown rule.kind: ${kind}`);
  }
}
