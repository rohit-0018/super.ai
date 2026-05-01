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
    if (ratio >= 1.5 && totalTx >= 100) {
      b.push(`Buy/sell ratio ${ratio.toFixed(2)} (${totalTx} txns)`, 'positive', +1.5, 'Aggressive accumulation');
    } else if (ratio >= 1.2 && totalTx >= 100) {
      b.push(`Mild buy edge, ratio ${ratio.toFixed(2)} (${totalTx} txns)`, 'positive', +0.5);
    } else if (ratio <= 0.6 && totalTx >= 100) {
      b.push(`Sell-side dominant, ratio ${ratio.toFixed(2)} (${totalTx} txns)`, 'negative', -1.5);
    } else if (totalTx < 30) {
      b.push(`Thin activity — only ${totalTx} txns 24h`, 'negative', -0.8);
    } else {
      // Balanced flow: no accumulation edge — small negative
      b.push(`Balanced order flow, ratio ${ratio.toFixed(2)} (${totalTx} txns)`, 'negative', -0.3, 'No clear accumulation signal');
    }
  } else {
    b.push('No transaction data — cannot score order flow', 'negative', -0.5);
  }

  const vol = meta.volume24hUsd ?? 0;
  const liq = meta.liquidityUsd ?? 0;
  if (vol > 0 && liq > 0) {
    const velocity = vol / liq;
    if (velocity >= 3) b.push(`Volume/liquidity ${velocity.toFixed(1)}× — strong rotation`, 'positive', +1.0);
    else if (velocity >= 2) b.push(`Volume/liquidity ${velocity.toFixed(1)}×`, 'positive', +0.8, 'Real activity, not just sitting');
    else if (velocity >= 0.5) b.push(`Volume/liquidity ${velocity.toFixed(1)}× — moderate`, 'negative', -0.2);
    else b.push(`Low volume vs liquidity (${velocity.toFixed(1)}×)`, 'negative', -0.8);
  } else if (vol > 0) {
    b.info(`Volume $${fmtUsd(vol)} — no liquidity reference`);
  }

  if ((safety.holdersCount ?? 0) > 5000) b.push(`${safety.holdersCount!.toLocaleString()} holders — established`, 'positive', +0.8);
  else if ((safety.holdersCount ?? 0) > 2000) b.push(`${safety.holdersCount} holders`, 'positive', +0.5);
  else if ((safety.holdersCount ?? 0) > 500) b.push(`${safety.holdersCount} holders — growing`, 'negative', -0.2);
  else if ((safety.holdersCount ?? 0) > 0) b.push(`Only ${safety.holdersCount} holders — thin base`, 'negative', -0.8);

  // Pair age as proxy for survival (smart money avoids brand-new tokens)
  if (meta.pairAgeHours != null) {
    if (meta.pairAgeHours >= 24 * 30) b.push(`Pair ${Math.round(meta.pairAgeHours/24)}d old — survived rug window`, 'positive', +0.5);
    else if (meta.pairAgeHours < 24) b.push('Pair <24h — rug window open', 'negative', -0.5);
  }

  if ((meta.priceChange.h1 ?? 0) > 3 && totalTx > 0 && buys / Math.max(1, sells) > 1.2) {
    b.push('Fresh 1h pump on buy pressure', 'positive', +1.0);
  }
  if ((meta.priceChange.h1 ?? 0) < -5 && totalTx > 0 && buys / Math.max(1, sells) > 1.5) {
    b.push('Dip being absorbed (buys > sells on 1h drawdown)', 'positive', +1.5, 'Classic accumulation pattern');
  }

  b.info('Heuristic only — Nansen/Arkham wallet labels not wired');

  const r = b.finalize(1.0);
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
    if (mc >= 1_000_000_000) b.push(`Mega cap $${fmtUsd(mc)}`, 'positive', +0.8, 'Established — sector leader');
    else if (mc >= 50_000_000) b.push(`Mid-cap $${fmtUsd(mc)}`, 'positive', +1.2, 'Real project size, narrative-ready');
    else if (mc >= 5_000_000) b.push(`Small cap $${fmtUsd(mc)} — not yet established`, 'negative', -0.5, 'Narrative plays need MCap behind them');
    else b.push(`Micro cap $${fmtUsd(mc)} — too small for a narrative bet`, 'negative', -1.5);
  } else {
    b.push('MCap not available — cannot size narrative potential', 'negative', -0.3);
  }

  const age = meta.pairAgeHours;
  if (age != null) {
    if (age >= 24 * 30) b.push(`Mature pair (${Math.round(age / 24)}d)`, 'positive', +1.0, 'Survived multiple market cycles');
    else if (age >= 24 * 14) b.push(`Established pair (${Math.round(age / 24)}d)`, 'positive', +0.8, 'Has survived early-rug window');
    else if (age >= 24 * 7) b.push(`Pair ${Math.round(age / 24)}d old — early stage`, 'negative', -0.3);
    else b.push('Too new for a narrative bet', 'negative', -1.0);
  }

  const text = `${meta.symbol ?? ''} ${meta.name ?? ''}`.toLowerCase();
  const sectors: { [pat: string]: string } = {
    '\\bai\\b|gpt|agent|llm|\\bml\\b': 'AI / Agents',
    'depin|helium|iot|wifi|render|compute': 'DePIN',
    'rwa|real-world|treasury|ondo|tbill': 'RWA',
    'l2|layer2|rollup|arb|op|base|zksync|linea': 'L2 / Scaling',
    'game|gamefi|play|metagame': 'Gaming',
    'doge|shib|pepe|wif|bonk|mog|popcat|meme': 'Memes',
    'stake|lst|lrt|eigen|restake': 'LST / Restaking',
    'sol|eth|btc|avax|matic|dot|ada': 'Layer 1',
    'dex|swap|amm|lp|pool|liquidity': 'DeFi / DEX',
    'nft|ordinals|inscription|rune': 'NFT / Ordinals',
  };
  let sector: string | null = null;
  for (const [pat, name] of Object.entries(sectors)) {
    if (new RegExp(pat).test(text)) { sector = name; break; }
  }
  if (sector) {
    const hot = ['AI / Agents', 'DePIN', 'RWA', 'L2 / Scaling', 'LST / Restaking'].includes(sector);
    b.push(`Sector: ${sector}`, hot ? 'positive' : 'negative', hot ? +1.0 : -0.2, 'Heuristic from symbol/name');
  } else {
    b.push('No known sector tag — harder to ride a narrative wave', 'negative', -0.4);
  }

  if ((safety.rugScore ?? 100) < 30 && (safety.holdersCount ?? 0) > 5000) {
    b.push('Low rug score + broad holder base', 'positive', +0.8);
  }

  const vol = meta.volume24hUsd ?? 0;
  if (vol >= 10_000_000) b.push(`Deep volume $${fmtUsd(vol)} — narrative is moving money`, 'positive', +0.8);
  else if (vol >= 1_000_000) b.push(`Active volume $${fmtUsd(vol)}`, 'positive', +0.5);
  else if (vol >= 100_000) b.push(`Moderate volume $${fmtUsd(vol)}`, 'negative', -0.2);
  else if (vol > 0) b.push(`Low volume $${fmtUsd(vol)} — thin interest`, 'negative', -0.8);

  b.info('Narrative layer — wire LunarCrush/Kaito for mindshare + sentiment confirmation');

  const r = b.finalize(1.2);
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

  // Kill switch first — overrides everything
  if (safety.honeypot === 'yes') {
    b.push('Honeypot — cannot momentum-trade an unsellable token', 'critical', -10);
  } else if ((safety.rugScore ?? 0) >= 70) {
    b.push(`Rug score ${safety.rugScore}/100 — too risky to momentum-trade`, 'critical', -4);
  }

  const h1 = meta.priceChange.h1, h6 = meta.priceChange.h6, h24 = meta.priceChange.h24;

  // Score using whatever timeframes are available — don't require all three
  if (h24 != null) {
    if (h24 >= 20) {
      if ((h1 ?? 0) >= 0) b.push(`Strong 24h rally ${fmtPct(h24)}, holding on 1h`, 'positive', +1.5);
      else b.push(`Big 24h ${fmtPct(h24)} but 1h fading — blow-off risk`, 'negative', -1.0);
    } else if (h24 >= 8) {
      b.push(`24h momentum ${fmtPct(h24)}`, 'positive', h1 != null && h1 >= 0 ? +1.2 : +0.6);
    } else if (h24 >= 2) {
      b.push(`Mild 24h gain ${fmtPct(h24)}`, 'negative', -0.2);
    } else if (h24 < -10) {
      b.push(`Dumping 24h ${fmtPct(h24)}`, 'negative', -1.5);
    } else if (h24 < -3) {
      b.push(`Downtrend 24h ${fmtPct(h24)}`, 'negative', -0.8);
    } else {
      b.push(`Flat 24h (${fmtPct(h24)}) — no momentum`, 'negative', -0.5);
    }
  }

  if (h6 != null) {
    if (h6 >= 5) b.push(`6h surge ${fmtPct(h6)} — intraday momentum`, 'positive', +0.8);
    else if (h6 < -5) b.push(`6h drop ${fmtPct(h6)} — selling into strength`, 'negative', -0.8);
  }

  if (h1 != null) {
    if (h1 >= 5) b.push(`1h spike ${fmtPct(h1)} — breaking out now`, 'positive', +0.8, 'Momentum is live');
    else if (h1 < -5) b.push(`1h reversal ${fmtPct(h1)} — momentum failing`, 'negative', -0.8);
  }

  // Vol/MCap: primary momentum confirmation
  const vol = meta.volume24hUsd, mc = meta.marketCapUsd;
  if (vol != null && mc != null && mc > 0) {
    const ratio = vol / mc;
    if (ratio >= 0.5) b.push(`Vol/MCap ${(ratio*100).toFixed(0)}% — heavy rotation`, 'positive', +1.0, 'Money moving in size');
    else if (ratio >= 0.2) b.push(`Vol/MCap ${(ratio*100).toFixed(0)}% — moderate rotation`, 'positive', +0.4);
    else if (ratio >= 0.05) b.push(`Vol/MCap ${(ratio*100).toFixed(0)}% — thin`, 'negative', -0.5);
    else b.push(`Vol/MCap ${(ratio*100).toFixed(0)}% — very low turnover`, 'negative', -1.0);
  } else if (vol != null) {
    if (vol >= 5_000_000) b.push(`High absolute volume $${fmtUsd(vol)}`, 'positive', +0.6);
    else if (vol < 50_000) b.push(`Low volume $${fmtUsd(vol)} — illiquid`, 'negative', -0.8);
    else b.push(`Volume $${fmtUsd(vol)} — MCap unavailable for ratio`, 'negative', -0.1);
  }

  const buys = meta.txns24h?.buys, sells = meta.txns24h?.sells;
  if (buys != null && sells != null) {
    const total = buys + sells;
    if (total > 200 && buys > sells * 1.5) b.push(`${total} txns, strongly buy-dominant`, 'positive', +0.8);
    else if (total > 50 && buys > sells) b.push(`${total} txns, buy-side leading`, 'positive', +0.3);
    else if (total > 50 && sells > buys * 1.5) b.push(`${total} txns, sell-dominant — distribution`, 'negative', -0.8);
    else if (total < 20) b.push(`Only ${total} txns — too thin for momentum trade`, 'negative', -0.8);
  }

  b.info('Perp / OI / funding rate not wired — Coinglass integration would confirm derivatives leg');

  const r = b.finalize(1.0);
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
