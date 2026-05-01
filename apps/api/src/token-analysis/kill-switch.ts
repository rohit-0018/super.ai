import type { KillResult, SafetySignals, TokenMeta } from './token-analysis.types';

interface KillCheck {
  id: string;
  reason: string;
  test: (s: SafetySignals, m: TokenMeta) => boolean;
}

const CHECKS: KillCheck[] = [
  {
    id: 'honeypot',
    reason: 'Honeypot — token cannot be sold',
    test: (s) => s.honeypot === 'yes',
  },
  {
    id: 'mint_authority',
    reason: 'Mint authority active — deployer can print unlimited tokens',
    test: (s) => s.mintAuthority === true,
  },
  {
    id: 'freeze_authority',
    reason: 'Freeze authority active — deployer can freeze your balance',
    test: (s) => s.freezeAuthority === true,
  },
  {
    id: 'high_buy_tax',
    reason: 'Buy tax exceeds 10% — entering costs more than you get',
    test: (s) => (s.buyTax ?? 0) > 1000,
  },
  {
    id: 'high_sell_tax',
    reason: 'Sell tax exceeds 10% — exiting costs more than you get',
    test: (s) => (s.sellTax ?? 0) > 1000,
  },
  {
    id: 'no_liquidity',
    reason: 'Liquidity below $5,000 — impossible to exit meaningfully',
    test: (_s, m) => (m.liquidityUsd ?? Infinity) < 5_000,
  },
  {
    id: 'too_young',
    reason: 'Token less than 3 minutes old — wait for liquidity to stabilize',
    test: (_s, m) => typeof m.pairAgeHours === 'number' && m.pairAgeHours < 0.05,
  },
  {
    id: 'rug_score_critical',
    reason: 'Rug score critically high (>80/100) — multiple severe risk vectors',
    test: (s) => (s.rugScore ?? 0) > 80,
  },
];

/**
 * Runs all kill-switch checks against fetched safety + market data.
 * Returns on first trigger — stops analysis immediately and skips Claude.
 */
export function checkKill(safety: SafetySignals, meta: TokenMeta): KillResult {
  for (const check of CHECKS) {
    if (check.test(safety, meta)) {
      return { triggered: true, checkId: check.id, reason: check.reason };
    }
  }
  return { triggered: false };
}
