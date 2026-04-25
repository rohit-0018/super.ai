import type {
  Playbook, PlaybookSignal, PlaybookBreakdown, TokenMeta, SafetySignals, Verdict,
} from './token-analysis.types';

/**
 * Four playbook scorers. Each builds a list of signals; signals with a
 * non-zero `delta` contribute to the score. Final = clamp(baseline + Σdeltas).
 *
 * Insufficient-data rule: if `Σ|delta|` (the "evidence total") is below the
 * playbook's threshold, we refuse to commit to a score. This stops empty
 * inputs from drifting toward the 5.0 baseline and producing meaningless
 * "5.8" verdicts.
 */

const BASELINE = 5.0;

export function runPlaybooks(meta: TokenMeta, safety: SafetySignals): Playbook[] {
  return [
    earlySafe(meta, safety),
    smartMoney(meta, safety),
    narrative(meta, safety),
    momentum(meta, safety),
  ];
}

/* ------------------------------------------------------------------ */
/* Builder                                                            */
/* ------------------------------------------------------------------ */

class Builder {
  signals: PlaybookSignal[] = [];

  add(s: PlaybookSignal) { this.signals.push(s); }

  push(label: string, weight: PlaybookSignal['weight'], delta: number, detail?: string) {
    this.signals.push({ label, weight, delta, detail });
  }

  info(label: string, detail?: string) {
    this.signals.push({ label, weight: 'info', detail });
  }

  finalize(threshold: number): { score: number | null; verdict: Verdict; breakdown: PlaybookBreakdown } {
    const applied = this.signals
      .filter((s) => typeof s.delta === 'number' && s.delta !== 0)
      .map((s) => ({ label: s.label, delta: s.delta as number, weight: s.weight }));
    const sum = applied.reduce((acc, a) => acc + a.delta, 0);
    const evidenceTotal = applied.reduce((acc, a) => acc + Math.abs(a.delta), 0);
    const raw = BASELINE + sum;
    const clamped = Math.max(0, Math.min(10, raw));

    const breakdown: PlaybookBreakdown = {
      baseline: BASELINE,
      appliedDeltas: applied,
      raw,
      clamped: round1(clamped),
      evidenceTotal: round1(evidenceTotal),
      evidenceThreshold: threshold,
    };

    if (evidenceTotal < threshold) {
      this.signals.push({
        label: 'Insufficient evidence to commit',
        weight: 'info',
        detail:
          `Total evidence ${evidenceTotal.toFixed(1)} < threshold ${threshold}. ` +
          `Add more data sources (holder counts, volume, safety) before relying on this playbook.`,
      });
      return { score: null, verdict: 'insufficient_data', breakdown };
    }

    return { score: round1(clamped), verdict: toVerdict(clamped), breakdown };
  }
}

/* ------------------------------------------------------------------ */
/* 1. Early + Safe sniping                                           */
/* ------------------------------------------------------------------ */
function earlySafe(meta: TokenMeta, safety: SafetySignals): Playbook {
  const b = new Builder();

  if (safety.honeypot === 'yes') {
    b.push('Honeypot detected', 'critical', -10, 'Sell simulation failed — token cannot be sold');
  } else if (safety.honeypot === 'no') {
    b.push('Honeypot check passed', 'positive', +0.6);
  }
  if (safety.mintAuthority === true) b.push('Mint authority enabled', 'critical', -3, 'Dev can mint unlimited supply');
  if (safety.mintAuthority === false) b.push('Mint authority renounced', 'positive', +0.8);
  if (safety.freezeAuthority === true) b.push('Freeze authority enabled', 'negative', -1.5);
  if (safety.freezeAuthority === false) b.push('Freeze authority renounced', 'positive', +0.5);

  if ((safety.buyTax ?? 0) > 500 || (safety.sellTax ?? 0) > 500) {
    b.push(`High taxes (buy ${bpsToPct(safety.buyTax)}/sell ${bpsToPct(safety.sellTax)})`, 'critical', -2);
  } else if (safety.buyTax != null && safety.sellTax != null && safety.buyTax + safety.sellTax === 0) {
    b.push('Zero buy/sell tax', 'positive', +0.6);
  }

  if (safety.rugScore != null) {
    if (safety.rugScore >= 60) b.push(`High rug score ${safety.rugScore}/100`, 'critical', -3);
    else if (safety.rugScore >= 30) b.push(`Elevated rug score ${safety.rugScore}/100`, 'negative', -1);
    else b.push(`Low rug score ${safety.rugScore}/100`, 'positive', +1.0);
  }

  const mc = meta.marketCapUsd;
  if (mc != null) {
    if (mc < 2_000_000) b.push(`Small cap $${fmtUsd(mc)}`, 'positive', +2.0, 'Room for multi-x upside');
    else if (mc < 20_000_000) b.info(`Mid-small cap $${fmtUsd(mc)}`);
    else b.push(`Cap too large for early-safe ($${fmtUsd(mc)})`, 'negative', -1.5);
  }

  if (safety.lpLocked === 'yes') b.push('LP locked', 'positive', +1.2);
  else if (safety.lpLocked === 'no') b.push('LP not locked', 'critical', -2.5);

  if (meta.liquidityUsd != null) {
    if (meta.liquidityUsd >= 50_000) b.push(`Liquidity $${fmtUsd(meta.liquidityUsd)}`, 'positive', +0.6);
    else if (meta.liquidityUsd < 20_000) b.push(`Thin liquidity $${fmtUsd(meta.liquidityUsd)}`, 'negative', -1.0);
  }

  if (meta.pairAgeHours != null) {
    if (meta.pairAgeHours < 48) b.push(`Pair age ${Math.round(meta.pairAgeHours)}h`, 'positive', +0.8, 'Still early in launch window');
    else if (meta.pairAgeHours > 24 * 14) b.push(`Pair is ${Math.round(meta.pairAgeHours / 24)}d old`, 'negative', -0.5);
  }

  if (safety.topHoldersPct != null) {
    if (safety.topHoldersPct < 25) b.push(`Top-10 holders ${safety.topHoldersPct.toFixed(1)}%`, 'positive', +0.8);
    else if (safety.topHoldersPct > 60) b.push(`Top-10 holders ${safety.topHoldersPct.toFixed(1)}%`, 'critical', -2.0);
  }

  for (const f of safety.flags) b.push(f, 'negative', -0.4);

  const r = b.finalize(2.0);
  return {
    key: 'early_safe',
    label: 'Early + Safe Sniping',
    description: 'First-in, small cap, verified safe. Size conservatively; plan tranched exits at 2×/5×/10×.',
    score: r.score,
    verdict: r.verdict,
    signals: b.signals,
    breakdown: r.breakdown,
    plan: r.score == null ? undefined : {
      sizeHint: '0.25–1% of portfolio',
      entry: 'Market buy now, or set a limit -10% from spot if momentum cools',
      stop: '-25% from entry or if LP-lock expires / large wallet unloads',
      targets: ['+100% (sell 33%)', '+400% (sell 33%)', '+900% (sell final 33%)'],
      notes: 'This is a speculative snipe. Only risk what you can fully lose.',
    },
  };
}

/* ------------------------------------------------------------------ */
/* 2. Smart-money confluence                                          */
/* ------------------------------------------------------------------ */
function smartMoney(meta: TokenMeta, safety: SafetySignals): Playbook {
  const b = new Builder();

  const buys = meta.txns24h?.buys ?? 0;
  const sells = meta.txns24h?.sells ?? 0;
  const totalTx = buys + sells;
  if (totalTx > 0) {
    const ratio = sells > 0 ? buys / sells : 2;
    if (ratio >= 1.5 && totalTx >= 100) b.push(`Buy/sell ratio ${ratio.toFixed(2)} over ${totalTx} txns`, 'positive', +1.5, 'Aggressive accumulation');
    else if (ratio <= 0.6 && totalTx >= 100) b.push(`Sell-side dominant (ratio ${ratio.toFixed(2)})`, 'negative', -1.5);
    else if (totalTx < 30) b.push(`Thin activity (${totalTx} txns 24h)`, 'negative', -0.5);
    else b.info(`Balanced flow (${totalTx} txns, ratio ${ratio.toFixed(2)})`);
  }

  const vol = meta.volume24hUsd ?? 0;
  const liq = meta.liquidityUsd ?? 0;
  if (vol > 0 && liq > 0) {
    const velocity = vol / liq;
    if (velocity >= 2) b.push(`Volume/liquidity ${velocity.toFixed(1)}×`, 'positive', +0.8, 'Real activity, not just sitting');
    else if (velocity < 0.3) b.push(`Low volume vs liquidity (${velocity.toFixed(1)}×)`, 'negative', -0.8);
  }

  if ((safety.holdersCount ?? 0) > 2000) b.push(`${safety.holdersCount} holders`, 'positive', +0.5);
  else if ((safety.holdersCount ?? 0) > 0 && (safety.holdersCount as number) < 200)
    b.push(`Only ${safety.holdersCount} holders`, 'negative', -0.5);

  if ((meta.priceChange.h1 ?? 0) > 3 && totalTx > 0 && buys / Math.max(1, sells) > 1.2) {
    b.push('Fresh 1h pump on buy pressure', 'positive', +1.0);
  }
  if ((meta.priceChange.h1 ?? 0) < -5 && totalTx > 0 && buys / Math.max(1, sells) > 1.5) {
    b.push('Dip being absorbed (buys > sells on 1h drawdown)', 'positive', +1.5, 'Classic accumulation pattern');
  }

  b.info('Heuristic only', 'Free-tier plan: Nansen/Arkham labels not wired. Upgrade to label real smart-money wallets.');

  const r = b.finalize(1.5);
  return {
    key: 'smart_money',
    label: 'Smart-Money Confluence',
    description: 'Act when experienced wallets are accumulating. Free-tier uses buy/sell + volume heuristics; real smart-money tags require Nansen or Arkham.',
    score: r.score,
    verdict: r.verdict,
    signals: b.signals,
    breakdown: r.breakdown,
    plan: r.score == null ? undefined : {
      sizeHint: '1–3% of portfolio',
      entry: 'Scale in — 40% now, 30% on any -8% dip, 30% on confirmation break of 24h high',
      stop: '-12% from average entry OR on 1h reversal with buy-ratio collapse',
      targets: ['+25% (sell 40%)', '+60% (sell 40%)', '+120% (trail remainder)'],
    },
  };
}

/* ------------------------------------------------------------------ */
/* 3. Narrative / sector bet                                          */
/* ------------------------------------------------------------------ */
function narrative(meta: TokenMeta, safety: SafetySignals): Playbook {
  const b = new Builder();

  const mc = meta.marketCapUsd;
  if (mc != null) {
    if (mc >= 50_000_000 && mc < 1_000_000_000) b.push(`Mid-cap $${fmtUsd(mc)}`, 'positive', +1.2, 'Real project size');
    else if (mc >= 1_000_000_000) b.info(`Large cap $${fmtUsd(mc)}`);
    else if (mc < 2_000_000) b.push(`Cap too small for narrative play ($${fmtUsd(mc)})`, 'negative', -1.5);
  }

  const age = meta.pairAgeHours;
  if (age != null) {
    if (age >= 24 * 14) b.push(`Mature pair (${Math.round(age / 24)}d)`, 'positive', +0.8, 'Has survived early-rug window');
    else if (age < 48) b.push('Too new for a narrative bet', 'negative', -1.0);
  }

  const text = `${meta.symbol ?? ''} ${meta.name ?? ''}`.toLowerCase();
  const sectors: { [pat: string]: string } = {
    '\\bai\\b|gpt|agent|llm|ml|\\bml\\b': 'AI / Agents',
    'depin|helium|iot|wifi|render|compute': 'DePIN',
    'rwa|real-world|treasury|ondo|tbill': 'RWA',
    'l2|layer2|rollup|arb|op|base|zksync|linea': 'L2 / Scaling',
    'game|gamefi|play|metagame': 'Gaming',
    'doge|shib|pepe|wif|bonk|mog|popcat|meme': 'Memes',
    'stake|lst|lrt|eigen|restake': 'LST / Restaking',
  };
  let sector: string | null = null;
  for (const [pat, name] of Object.entries(sectors)) {
    if (new RegExp(pat).test(text)) { sector = name; break; }
  }
  if (sector) {
    const hot = ['AI / Agents', 'DePIN', 'RWA', 'L2 / Scaling', 'LST / Restaking'].includes(sector);
    b.push(`Sector match: ${sector}`, hot ? 'positive' : 'info', hot ? +1.0 : 0, 'Heuristic from symbol/name');
  }

  if ((safety.rugScore ?? 100) < 30 && (safety.holdersCount ?? 0) > 5000) {
    b.push('Low rug score + broad holder base', 'positive', +0.8);
  }
  if ((meta.volume24hUsd ?? 0) > 1_000_000) b.push(`Deep volume $${fmtUsd(meta.volume24hUsd!)}`, 'positive', +0.5);

  b.info('Narrative layer is shallow on free tier', 'Wire LunarCrush/Kaito for mindshare + sentiment confirmation.');

  const r = b.finalize(2.0);
  return {
    key: 'narrative',
    label: 'Narrative / Sector Bet',
    description: 'Hold the sector leader while the thesis plays out. Exit on narrative invalidation, not short-term price.',
    score: r.score,
    verdict: r.verdict,
    signals: b.signals,
    breakdown: r.breakdown,
    plan: r.score == null ? undefined : {
      sizeHint: '3–8% of portfolio',
      entry: 'DCA 3–5 slices over 1–3 weeks',
      stop: 'Narrative invalidation OR -25% hard floor',
      targets: ['Trim 25% at +50%, 25% at +150%, hold core'],
      notes: 'Check weekly, not hourly. Set news/event alerts, not price alerts.',
    },
  };
}

/* ------------------------------------------------------------------ */
/* 4. Momentum                                                         */
/* ------------------------------------------------------------------ */
function momentum(meta: TokenMeta, safety: SafetySignals): Playbook {
  const b = new Builder();

  const h1 = meta.priceChange.h1, h6 = meta.priceChange.h6, h24 = meta.priceChange.h24;
  if (h24 != null && h6 != null && h1 != null) {
    if (h24 >= 8 && h6 >= 3 && h1 >= 0) b.push(`Trending up (1h ${fmtPct(h1)}, 6h ${fmtPct(h6)}, 24h ${fmtPct(h24)})`, 'positive', +1.5);
    else if (h24 >= 15 && h1 < -2) b.push(`Big 24h but cooling on 1h (${fmtPct(h1)})`, 'negative', -1.5, 'Late — blow-off risk');
    else if (h24 < 0) b.push(`Trending down (24h ${fmtPct(h24)})`, 'negative', -1.5);
  }

  const vol = meta.volume24hUsd, mc = meta.marketCapUsd;
  if (vol != null && mc != null && mc > 0) {
    const ratio = vol / mc;
    if (ratio >= 0.3) b.push(`Volume / MC ratio ${ratio.toFixed(2)}`, 'positive', +1.0, 'Heavy rotation');
    else if (ratio < 0.05 && vol > 0) b.push(`Thin volume vs MC (${ratio.toFixed(2)})`, 'negative', -0.8);
  }

  const buys = meta.txns24h?.buys, sells = meta.txns24h?.sells;
  if (buys != null && sells != null && buys + sells > 200 && buys > sells) {
    b.push(`${buys + sells} txns, buy-dominant`, 'positive', +0.8);
  }

  if (safety.honeypot === 'yes' || (safety.rugScore ?? 0) >= 70) {
    b.push('Unsafe to momentum-trade (honeypot or high rug score)', 'critical', -10);
  }

  b.info('Perp / OI / funding data not wired', 'Coinglass / Hyperliquid integration would confirm derivatives leg.');

  const r = b.finalize(2.0);
  return {
    key: 'momentum',
    label: 'Momentum + Derivatives',
    description: 'Chase confirmed breakouts with volume + OI behind them. Tight stops, short holds.',
    score: r.score,
    verdict: r.verdict,
    signals: b.signals,
    breakdown: r.breakdown,
    plan: r.score == null ? undefined : {
      sizeHint: '0.5–2% of portfolio',
      entry: 'Enter on break-and-retest of 24h high with expanding volume',
      stop: 'Below retest low, typically -4 to -8%',
      targets: ['+8% (sell 33%)', '+15% (sell 33%)', 'Trail remainder under 15m EMA'],
      notes: 'This is a scalp. Be out in hours-to-days, not weeks.',
    },
  };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function round1(v: number) { return Math.round(v * 10) / 10; }

function toVerdict(score: number): Verdict {
  if (score >= 8) return 'strong_yes';
  if (score >= 6.5) return 'yes';
  if (score >= 4) return 'neutral';
  if (score >= 2) return 'no';
  return 'strong_no';
}

function fmtUsd(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}
function fmtPct(n: number): string { return `${n > 0 ? '+' : ''}${n.toFixed(1)}%`; }
function bpsToPct(bps?: number): string { return bps == null ? '?' : `${(bps / 100).toFixed(1)}%`; }
