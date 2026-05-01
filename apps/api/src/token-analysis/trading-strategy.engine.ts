import type { HolderMetrics, SafetySignals, SmartMoneyResult, TokenMeta } from './token-analysis.types';
import type { ProfileDefinition } from './profile.config';

export interface TradingStrategy {
  profile: string;
  profileLabel: string;
  entryPrice: number | null;
  entryZone: { low: number; high: number } | null;
  entryNote: string;
  stopLossPrice: number | null;
  stopLossPct: number;
  stopLossNote: string;
  targets: Array<{
    label: string;
    pct: number;             // gain % from entry
    price: number | null;
    action: string;
  }>;
  trailingStop: string;
  maxHoldTime: string;
  positionSizing: {
    pctRange: [number, number];
    portfolioNote: string;
    dollarRange: [number, number] | null;  // null if no portfolioUsd provided
    modifier: number;                      // 0.0–1.0 scale factor (1.0 = full size)
    modifierReason: string | null;
  };
  riskReward: number;        // ratio at T1 (e.g. 2.5 = 2.5:1)
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  confidenceReason: string;
  warnings: string[];        // active flags that affect sizing or timing
}

/**
 * Generates a profile-aware trading strategy from token data.
 * All price levels are calculated relative to the current price.
 */
export function buildTradingStrategy(
  meta: TokenMeta,
  safety: SafetySignals,
  holders: HolderMetrics | undefined,
  smartMoney: SmartMoneyResult | undefined,
  profile: ProfileDefinition,
  portfolioUsd: number | null,
): TradingStrategy {
  const price = meta.priceUsd ?? null;

  // ── Entry zone ──────────────────────────────────────────────────────────
  const entryZone = price
    ? { low: price * 0.97, high: price * 1.03 }
    : null;

  let entryNote = 'Market buy at spot or limit within ±3% zone.';
  if (holders?.lifecycle?.stage === 'bonding') {
    entryNote = `Bonding curve at ${holders.lifecycle.bondingCurvePct?.toFixed(0) ?? '?'}% — enter before graduation for best price, exit on spike.`;
  } else if (meta.pairAgeHours != null && meta.pairAgeHours < 1) {
    entryNote = 'Token very new (<1h). Wait for initial dump to stabilize, then enter on reversal.';
  }

  // ── Stop loss ────────────────────────────────────────────────────────────
  let stopPct = profile.strategy.stopLossPct;
  const warnings: string[] = [];

  // Tighten stop if thin liquidity (price impact > 5% at $1K)
  if (holders?.priceImpact?.buy1000Usd != null && holders.priceImpact.buy1000Usd > 5) {
    stopPct = Math.min(stopPct, 15);
    warnings.push(`Thin liquidity — $1K buy moves price ${holders.priceImpact.buy1000Usd.toFixed(1)}%. Use limit orders.`);
  }

  const stopLossPrice = price ? price * (1 - stopPct / 100) : null;
  let stopLossNote = `Hard stop at −${stopPct}% from entry.`;
  if (meta.liquidityUsd != null && meta.liquidityUsd < 30_000) {
    stopLossNote += ' Set as limit sell — thin book may gap past market stops.';
  }

  // ── Targets ──────────────────────────────────────────────────────────────
  const targets = profile.strategy.targets.map((mult, i) => {
    const pct = Math.round((mult - 1) * 100);
    const p = price ? price * mult : null;
    const actions = [
      'Take 30-40% profit, move stop to breakeven.',
      'Take 40-50% of remaining, trail stop.',
      'Let remaining ride with trailing stop.',
    ];
    return {
      label: `T${i + 1}`,
      pct,
      price: p,
      action: actions[i] ?? 'Take partial profit.',
    };
  });

  // ── Risk/reward ──────────────────────────────────────────────────────────
  const t1Pct = (profile.strategy.targets[0] - 1) * 100;
  const riskReward = stopPct > 0 ? t1Pct / stopPct : 1;

  // ── Position sizing ───────────────────────────────────────────────────────
  let modifier = 1.0;
  let modifierReason: string | null = null;

  if (holders?.bundleInfo?.detected && (holders.bundleInfo.bundledSupplyPct ?? 0) > 10) {
    modifier *= 0.5;
    modifierReason = `Bundle detected — ${holders.bundleInfo.bundledSupplyPct?.toFixed(0)}% supply at risk. Half size.`;
    warnings.push(modifierReason);
  }
  if (safety.mintAuthority) {
    modifier *= 0.5;
    const reason = 'Mint authority active — deployer can dilute. Reduce size.';
    modifierReason = modifierReason ? `${modifierReason} ${reason}` : reason;
    warnings.push(reason);
  }
  if (safety.rugScore != null && safety.rugScore > 50) {
    modifier *= 0.4;
    const reason = `Rug score ${safety.rugScore}/100 — elevated risk. Minimum size only.`;
    modifierReason = modifierReason ? `${modifierReason} ${reason}` : reason;
    warnings.push(reason);
  }
  if (smartMoney && smartMoney.holdersFound > 0 && profile.key === 'alpha_hunt') {
    modifier = Math.min(1.2, modifier * 1.2);  // alpha boost when smart money found
    warnings.push(`Smart money signal detected — ${smartMoney.holdersFound} wallet(s). Small size boost applied.`);
  }

  const [minPct, maxPct] = profile.strategy.positionPctRange;
  const adjMin = parseFloat((minPct * modifier).toFixed(2));
  const adjMax = parseFloat((maxPct * modifier).toFixed(2));

  const dollarRange: [number, number] | null = portfolioUsd
    ? [
        Math.round(portfolioUsd * adjMin / 100),
        Math.round(portfolioUsd * adjMax / 100),
      ]
    : null;

  const portfolioNote = modifier < 1.0
    ? `${adjMin}–${adjMax}% of portfolio (reduced from ${minPct}–${maxPct}% — see warnings)`
    : `${adjMin}–${adjMax}% of portfolio`;

  // ── Confidence ───────────────────────────────────────────────────────────
  const dataPoints = [
    meta.marketCapUsd,
    meta.liquidityUsd,
    holders?.top10ConcentrationPct,
    holders?.bundleInfo,
    holders?.priceImpact,
    safety.rugScore,
  ].filter((v) => v != null).length;

  let confidence: TradingStrategy['confidence'];
  let confidenceReason: string;
  if (dataPoints >= 5 && safety.flags.length === 0) {
    confidence = 'HIGH';
    confidenceReason = `${dataPoints} data signals available, no safety flags.`;
  } else if (dataPoints >= 3) {
    confidence = 'MEDIUM';
    confidenceReason = `${dataPoints} data signals — some fields missing.`;
  } else {
    confidence = 'LOW';
    confidenceReason = 'Limited data — treat as indicative only.';
  }

  // ── Trailing stop note ────────────────────────────────────────────────────
  const trailing = `Move stop to breakeven after T1. Trail at −${profile.strategy.trailingStopAfterT1Pct}% after T2.`;

  const maxHoldHours = profile.strategy.maxHoldMs / (1000 * 60 * 60);
  const maxHoldTime = maxHoldHours < 1
    ? `${Math.round(maxHoldHours * 60)}min max`
    : maxHoldHours < 24
    ? `${maxHoldHours.toFixed(0)}h max`
    : `${(maxHoldHours / 24).toFixed(0)}d max`;

  return {
    profile: profile.key,
    profileLabel: profile.label,
    entryPrice: price,
    entryZone,
    entryNote,
    stopLossPrice,
    stopLossPct: stopPct,
    stopLossNote,
    targets,
    trailingStop: trailing,
    maxHoldTime,
    positionSizing: {
      pctRange: [adjMin, adjMax],
      portfolioNote,
      dollarRange,
      modifier,
      modifierReason,
    },
    riskReward: parseFloat(riskReward.toFixed(1)),
    confidence,
    confidenceReason,
    warnings,
  };
}
