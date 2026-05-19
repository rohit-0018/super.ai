/**
 * Phase 5: Condition Evaluator
 *
 * Evaluates a list of Prisma Condition records against a context object.
 * Field paths use dot-notation: "signal.mcap", "token.age_h", "risk.score".
 *
 * Supported operators:
 *   EQ, NEQ, GT, GTE, LT, LTE, IN, NOT_IN, CONTAINS, REGEX, EXISTS, BETWEEN
 *
 * All conditions in a Rule must pass (AND semantics).
 */

export interface ConditionRow {
  field: string;
  operator: string;
  value: unknown;
}

/** Resolve a dot-path like "signal.mcap" against a context object. */
function resolve(ctx: Record<string, any>, path: string): unknown {
  const parts = path.split('.');
  let cur: any = ctx;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

/** Returns true if ALL conditions pass. */
export function evaluateConditions(conditions: ConditionRow[], context: Record<string, any>): boolean {
  for (const c of conditions) {
    if (!evaluateOne(c, context)) return false;
  }
  return true;
}

function evaluateOne(c: ConditionRow, ctx: Record<string, any>): boolean {
  const actual = resolve(ctx, c.field);
  const expected = c.value;

  switch (c.operator.toUpperCase()) {
    case 'EQ':      return actual == expected;
    case 'NEQ':     return actual != expected;
    case 'GT':      return Number(actual) > Number(expected);
    case 'GTE':     return Number(actual) >= Number(expected);
    case 'LT':      return Number(actual) < Number(expected);
    case 'LTE':     return Number(actual) <= Number(expected);
    case 'IN':      return Array.isArray(expected) && expected.includes(actual);
    case 'NOT_IN':  return Array.isArray(expected) && !expected.includes(actual);
    case 'CONTAINS':
      return typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected);
    case 'REGEX': {
      if (typeof actual !== 'string' || typeof expected !== 'string') return false;
      try { return new RegExp(expected).test(actual); } catch { return false; }
    }
    case 'EXISTS':  return expected ? actual != null : actual == null;
    case 'BETWEEN': {
      if (!Array.isArray(expected) || expected.length < 2) return false;
      const n = Number(actual);
      return n >= Number(expected[0]) && n <= Number(expected[1]);
    }
    default:
      return false;
  }
}
