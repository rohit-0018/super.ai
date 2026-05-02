/**
 * Formats a TokenAnalysisReport into a rich Telegram HTML message.
 * All sections are conditional — nothing shown if data is missing.
 * parse_mode: 'HTML' required when sending.
 */

import { InlineKeyboard } from 'grammy';
import type { TokenAnalysisReport, AiVerdict } from '../token-analysis/token-analysis.types';

/* ─── Verdict config ────────────────────────────────────────────────────────── */
const VERDICT: Record<AiVerdict, { icon: string; label: string }> = {
  STRONG_BUY: { icon: '🚀', label: 'STRONG BUY' },
  BUY:        { icon: '📈', label: 'BUY' },
  CAUTIOUS:   { icon: '⚠️',  label: 'CAUTION' },
  SKIP:       { icon: '⏭',  label: 'SKIP' },
  HIGH_RISK:  { icon: '🚨', label: 'HIGH RISK' },
};

/* ─── Number helpers ────────────────────────────────────────────────────────── */
function usd(v: number | undefined | null): string {
  if (v == null) return '–';
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000)     return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000)         return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(2)}`;
}

function price(v: number | undefined | null): string {
  if (v == null) return '–';
  if (v >= 1)      return `$${v.toFixed(4)}`;
  if (v >= 0.0001) return `$${v.toFixed(6)}`;
  return `$${v.toExponential(3)}`;
}

function pct(v: number | undefined | null): string {
  if (v == null) return '';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}%`;
}

function age(hours: number | undefined): string {
  if (hours == null) return '–';
  if (hours < 1)  return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${Math.floor(hours / 24)}d`;
}

/* ─── Kill-switch report ────────────────────────────────────────────────────── */
/**
 * Detailed BLOCKED report. Even when the kill-switch fires, surface every signal
 * we have so the user understands WHY it failed — not just one cryptic line.
 * Same shape as the scan report, just with a danger header and a refusal CTA.
 */
export function formatKillReport(
  report: TokenAnalysisReport,
  address: string,
  webUrl: string,
): { text: string; keyboard: InlineKeyboard } {
  const m   = report.meta;
  const ai  = report.aiReasoning;
  const s   = report.safety;
  const hm  = report.holderMetrics;
  const soc = report.socialData;
  const sm  = report.smartMoney;

  const symbol    = esc(m.symbol ?? address.slice(0, 10) + '…');
  const chainIcon = m.chain === 'SOLANA' ? '◎' : m.chainId ?? '⬡';
  const ageStr    = age(m.pairAgeHours);
  const dexLabel  = m.dex ? esc(m.dex) : null;

  const lines: string[] = [];
  const sep = () => lines.push('');

  /* ── DANGER HEADER ──────────────────────────────────────────────────────── */
  lines.push(`🚨 <b>BLOCKED — TOKEN FLAGGED</b>`);
  lines.push(`<b>${symbol}</b>  ${chainIcon}  ${ageStr}${dexLabel ? `  ·  ${dexLabel}` : ''}`);
  lines.push(`<code>${address}</code>`);
  sep();

  /* ── FATAL REASON ───────────────────────────────────────────────────────── */
  lines.push(`⛔ <b>Why it's blocked</b>`);
  lines.push(esc(report.kill!.reason ?? 'Token did not pass safety kill-switch.'));
  if (report.kill?.checkId) lines.push(`<i>Failed check: ${esc(report.kill.checkId)}</i>`);
  sep();

  /* ── LORE / NARRATIVE ───────────────────────────────────────────────────── */
  // Even for blocked tokens, show what it IS — helps user judge if they're
  // chasing a known meme that just has a bad on-chain setup.
  if (ai?.lore) {
    lines.push(`📖 <b>What this is</b>`);
    lines.push(`<i>${esc(ai.lore)}</i>`);
    sep();
  }

  /* ── PRICE / MCAP ───────────────────────────────────────────────────────── */
  if (m.priceUsd != null || m.marketCapUsd) {
    if (m.priceUsd != null) {
      const p  = price(m.priceUsd);
      const h1 = pct(m.priceChange?.h1);
      const p5 = pct(m.priceChange?.m5);
      const changeStr = [h1 && `${h1} 1h`, p5 && `${p5} 5m`].filter(Boolean).join('  ');
      lines.push(`<b>${p}</b>${changeStr ? `  ${changeStr}` : ''}`);
    }
    if (m.marketCapUsd) {
      lines.push(`MCap ${usd(m.marketCapUsd)}${m.fdvUsd ? `  ·  FDV ${usd(m.fdvUsd)}` : ''}`);
    }
    sep();
  }

  /* ── MARKET SIGNALS ─────────────────────────────────────────────────────── */
  if (m.liquidityUsd || m.volume24hUsd || m.txns24h) {
    const mParts: string[] = [];
    if (m.volume24hUsd) mParts.push(`Vol ${usd(m.volume24hUsd)}`);
    if (m.liquidityUsd) mParts.push(`Liq ${usd(m.liquidityUsd)}`);
    if (m.txns24h)      mParts.push(`${m.txns24h.buys ?? 0}🟢 ${m.txns24h.sells ?? 0}🔴`);
    lines.push(`📊  ${mParts.join('  ·  ')}`);
    sep();
  }

  /* ── SAFETY BREAKDOWN ───────────────────────────────────────────────────── */
  if (s) {
    const rugTag = s.rugScore != null ? `  <i>[Rug ${s.rugScore}/100]</i>` : '';
    lines.push(`🛡 <b>SAFETY</b>${rugTag}`);
    if (s.honeypot === 'yes')          lines.push(`🚨 Honeypot — <b>cannot sell</b>`);
    else if (s.honeypot === 'no')      lines.push(`✅ Not a honeypot`);
    if (s.mintAuthority === true)      lines.push(`🚨 Mint authority active — supply can be inflated`);
    else if (s.mintAuthority === false) lines.push(`✅ Mint revoked`);
    if (s.freezeAuthority === true)    lines.push(`🚨 Freeze authority active — funds can be frozen`);
    else if (s.freezeAuthority === false) lines.push(`✅ Freeze revoked`);
    const buyTaxPct  = (s.buyTax  ?? 0) / 100;
    const sellTaxPct = (s.sellTax ?? 0) / 100;
    if (buyTaxPct > 1 || sellTaxPct > 1) {
      lines.push(`⚠️ Tax: buy ${buyTaxPct.toFixed(1)}%  sell ${sellTaxPct.toFixed(1)}%`);
    }
    if (s.lpLocked === 'yes') lines.push(`✅ LP locked${s.lpLockUntil ? ` until ${s.lpLockUntil.slice(0, 10)}` : ''}`);
    else if (s.lpLocked === 'no') lines.push(`🚨 LP unlocked — exit liquidity can vanish`);
    if (s.topHoldersPct != null) {
      const ic = s.topHoldersPct > 60 ? '🚨' : s.topHoldersPct > 35 ? '⚠️' : '✅';
      lines.push(`${ic} Top 10 holders: ${s.topHoldersPct.toFixed(1)}%`);
    }
    // All flags (no dedup — we want full transparency on a kill)
    s.flags.slice(0, 5).forEach(f => lines.push(`⚠️ ${esc(f)}`));
    sep();
  }

  /* ── DISTRIBUTION / LAUNCH FORENSICS ───────────────────────────────────── */
  if (hm) {
    const hParts: string[] = [];
    if (hm.totalHolders)                 hParts.push(`${hm.totalHolders.toLocaleString()} holders`);
    if (hm.organicScore != null)         hParts.push(`organic ${hm.organicScore}/100`);
    if (hm.top10ConcentrationPct != null) hParts.push(`top10: ${hm.top10ConcentrationPct.toFixed(0)}%`);
    if (hParts.length) lines.push(`👥  ${hParts.join('  ·  ')}`);
    if (hm.bundleDetected) {
      const bPct = hm.bundleInfo?.bundledSupplyPct;
      lines.push(`🚨 Bundle launch${bPct != null ? `: ${bPct.toFixed(1)}% supply grabbed` : ' detected'}`);
    }
    if (hm.lifecycle?.stage && hm.lifecycle.stage !== 'unknown') {
      const stageIcon: Record<string, string> = { bonding: '🔄', graduated: '🎓', migrated: '🔀', mature: '🌳' };
      const ico = stageIcon[hm.lifecycle.stage] ?? '';
      const bonding = hm.lifecycle.bondingCurvePct != null ? ` (${hm.lifecycle.bondingCurvePct.toFixed(0)}% curve)` : '';
      lines.push(`${ico} ${hm.lifecycle.stage}${bonding}${hm.lifecycle.launchPlatform ? `  ·  ${hm.lifecycle.launchPlatform}` : ''}`);
    }
    if (hm.priceImpact?.sell1000Usd != null) {
      lines.push(`Exit $1K: ${hm.priceImpact.sell1000Usd.toFixed(2)}% impact`);
    }
    sep();
  }

  /* ── SOCIAL ─────────────────────────────────────────────────────────────── */
  if (soc) {
    const sParts: string[] = [];
    if (soc.telegramMembers)        sParts.push(`TG ${soc.telegramMembers.toLocaleString()}`);
    if (soc.domainAgeDays != null)  sParts.push(soc.domainAgeDays < 7 ? `🆕 domain ${soc.domainAgeDays}d` : `domain ${soc.domainAgeDays}d`);
    if (soc.websiteChanged)         sParts.push(`⚠️ website changed`);
    if (sParts.length) { lines.push(`🌐  ${sParts.join('  ·  ')}`); sep(); }
  }

  /* ── SMART MONEY ────────────────────────────────────────────────────────── */
  if (sm?.holdersFound && sm.holdersFound > 0) {
    lines.push(`🐋 Smart money in this trap: <b>${sm.holdersFound}</b> wallet${sm.holdersFound > 1 ? 's' : ''}`);
    sep();
  }

  /* ── AI VERDICT (if reasoner ran) ───────────────────────────────────────── */
  if (ai) {
    lines.push(`━━━━━━━━━━━━━━━━━━`);
    const v = VERDICT[ai.verdict];
    lines.push(`${v.icon} <b>${v.label}</b>  ·  Score <b>${ai.score}/100</b>`);
    const cs = ai.categoryScores;
    lines.push(`<i>Safety ${cs.safety}  Dist ${cs.distribution}  Market ${cs.market}  Social ${cs.social}</i>`);
    if (ai.riskFactors.length) ai.riskFactors.slice(0, 4).forEach(r => lines.push(`↘ ${esc(r)}`));
    if (ai.contradictions?.length) ai.contradictions.slice(0, 2).forEach(c => lines.push(`⚡ ${esc(c)}`));
    if (ai.summary) lines.push(`\n<i>${esc(ai.summary.slice(0, 600))}${ai.summary.length > 600 ? '…' : ''}</i>`);
    lines.push(`━━━━━━━━━━━━━━━━━━`);
  }

  sep();
  lines.push(`<b>⛔ Verdict:</b> Do not trade this token.`);

  const deepLink = `${webUrl}/intel?address=${encodeURIComponent(address)}&profile=meme_hunter`;
  const keyboard = new InlineKeyboard()
    .url('⚠️ Full Safety Report', deepLink);
  if (m.url) keyboard.url('📊 Chart', m.url);

  return { text: lines.join('\n'), keyboard };
}

/* ─── Main scan report ──────────────────────────────────────────────────────── */
export function formatScanReport(
  report: TokenAnalysisReport,
  address: string,
  webUrl: string,
): { text: string; keyboard: InlineKeyboard } {
  const m   = report.meta;
  const ai  = report.aiReasoning;
  const s   = report.safety;
  const hm  = report.holderMetrics;
  const soc = report.socialData;
  const sm  = report.smartMoney;

  const symbol    = esc(m.symbol ?? address.slice(0, 10) + '…');
  const chainIcon = m.chain === 'SOLANA' ? '◎' : m.chainId ?? '⬡';
  const ageStr    = age(m.pairAgeHours);
  const dexLabel  = m.dex ? esc(m.dex) : null;

  const lines: string[] = [];
  const sep = () => lines.push('');

  /* ── HEADER ─────────────────────────────────────────────────────────────── */
  lines.push(`<b>${symbol}</b>  ${chainIcon}  ${ageStr}${dexLabel ? `  ·  ${dexLabel}` : ''}`);

  const p  = price(m.priceUsd);
  const h1 = pct(m.priceChange?.h1);
  const h6 = pct(m.priceChange?.h6);
  const p5 = pct(m.priceChange?.m5);

  if (m.priceUsd != null) {
    const changeStr = [h1 && `${h1} 1h`, p5 && `${p5} 5m`].filter(Boolean).join('  ');
    lines.push(`<b>${p}</b>${changeStr ? `  ${changeStr}` : ''}`);
  }
  if (m.marketCapUsd) {
    lines.push(`MCap ${usd(m.marketCapUsd)}${m.fdvUsd ? `  ·  FDV ${usd(m.fdvUsd)}` : ''}`);
  }
  sep();

  /* ── LORE / NARRATIVE ──────────────────────────────────────────────────── */
  // Show meme/origin story prominently — it's what users actually want to know
  // first when they ask about a token.
  if (ai?.lore) {
    lines.push(`📖 <b>${ai.isMeme ? 'The meme' : 'What this is'}</b>`);
    lines.push(`<i>${esc(ai.lore)}</i>`);
    sep();
  }

  /* ── MARKET ─────────────────────────────────────────────────────────────── */
  const hasMarket = m.liquidityUsd || m.volume24hUsd || m.txns24h;
  if (hasMarket) {
    const mParts: string[] = [];
    if (m.volume24hUsd) mParts.push(`Vol ${usd(m.volume24hUsd)}`);
    if (m.liquidityUsd) mParts.push(`Liq ${usd(m.liquidityUsd)}`);
    if (m.txns24h)      mParts.push(`${m.txns24h.buys ?? 0}🟢 ${m.txns24h.sells ?? 0}🔴`);
    lines.push(`📊  ${mParts.join('  ·  ')}`);
    sep();
  }

  /* ── SAFETY ─────────────────────────────────────────────────────────────── */
  if (s) {
    const rugTag = s.rugScore != null ? `  <i>[Rug ${s.rugScore}/100]</i>` : '';
    lines.push(`🛡 <b>SAFETY</b>${rugTag}`);

    // Honeypot — always show if known
    if (s.honeypot === 'yes') lines.push(`🚨 Honeypot — <b>DO NOT BUY</b>`);
    else if (s.honeypot === 'no') lines.push(`✅ No honeypot`);

    // Mint + Freeze (Solana) — only show if relevant
    const mintOk  = s.mintAuthority  === false;
    const frzOk   = s.freezeAuthority === false;
    const mintBad = s.mintAuthority  === true;
    const frzBad  = s.freezeAuthority === true;
    if (mintBad)       lines.push(`🚨 Mint authority active — can print unlimited supply`);
    else if (mintOk)   lines.push(`✅ Mint revoked`);
    if (frzBad)        lines.push(`⚠️ Freeze authority active`);
    else if (frzOk && !mintOk) lines.push(`✅ Freeze revoked`);

    // Taxes
    const buyTaxPct  = (s.buyTax  ?? 0) / 100;
    const sellTaxPct = (s.sellTax ?? 0) / 100;
    if (buyTaxPct > 1 || sellTaxPct > 1) {
      lines.push(`⚠️ Tax: buy ${buyTaxPct.toFixed(1)}%  sell ${sellTaxPct.toFixed(1)}%`);
    }

    // LP lock
    if (s.lpLocked === 'yes') {
      lines.push(`✅ LP locked${s.lpLockUntil ? ` until ${s.lpLockUntil.slice(0, 10)}` : ''}`);
    } else if (s.lpLocked === 'no') {
      lines.push(`⚠️ LP unlocked — rug risk`);
    }

    // Top holder concentration
    const topHld = s.topHoldersPct ?? null;
    if (topHld != null) {
      const icon = topHld > 60 ? '🚨' : topHld > 35 ? '⚠️' : '✅';
      lines.push(`${icon} Top 10 holders: ${topHld.toFixed(1)}%`);
    }

    // Remaining flags (deduplicate anything already shown)
    const shownConcepts = new Set(['honeypot', 'mint', 'freeze', 'lp', 'tax', 'holder']);
    s.flags.filter(f => !shownConcepts.has(f.toLowerCase().split(' ')[0])).slice(0, 2)
      .forEach(f => lines.push(`⚠️ ${esc(f)}`));

    sep();
  }

  /* ── HOLDERS / LAUNCH FORENSICS ─────────────────────────────────────────── */
  if (hm) {
    const hParts: string[] = [];
    if (hm.totalHolders)                    hParts.push(`${hm.totalHolders.toLocaleString()} holders`);
    if (hm.organicScore != null)             hParts.push(`organic ${hm.organicScore}/100`);
    if (hm.top10ConcentrationPct != null)    hParts.push(`top10: ${hm.top10ConcentrationPct.toFixed(0)}%`);
    if (hParts.length) lines.push(`👥  ${hParts.join('  ·  ')}`);

    if (hm.bundleDetected) {
      const bPct = hm.bundleInfo?.bundledSupplyPct;
      lines.push(`🚨 Bundle launch${bPct != null ? `: ${bPct.toFixed(1)}% supply grabbed` : ' detected'}`);
    } else if (hm.bundleInfo !== undefined) {
      lines.push(`✅ No bundle detected`);
    }

    if (hm.lifecycle?.stage && hm.lifecycle.stage !== 'unknown') {
      const stageIcon: Record<string, string> = {
        bonding: '🔄', graduated: '🎓', migrated: '🔀', mature: '🌳',
      };
      const ico = stageIcon[hm.lifecycle.stage] ?? '';
      const bonding = hm.lifecycle.bondingCurvePct != null
        ? ` (${hm.lifecycle.bondingCurvePct.toFixed(0)}% curve)` : '';
      lines.push(`${ico} ${hm.lifecycle.stage}${bonding}${hm.lifecycle.launchPlatform ? `  ·  ${hm.lifecycle.launchPlatform}` : ''}`);
    }

    if (hm.priceImpact?.sell1000Usd != null) {
      lines.push(`Exit $1K: ${hm.priceImpact.sell1000Usd.toFixed(2)}% impact`);
    }
    sep();
  }

  /* ── SOCIAL ─────────────────────────────────────────────────────────────── */
  if (soc) {
    const sParts: string[] = [];
    if (soc.telegramMembers)    sParts.push(`TG ${soc.telegramMembers.toLocaleString()}`);
    if (soc.domainAgeDays != null) {
      sParts.push(soc.domainAgeDays < 7 ? `🆕 domain ${soc.domainAgeDays}d old` : `domain ${soc.domainAgeDays}d`);
    }
    if (soc.websiteChanged)     sParts.push(`⚠️ website changed`);
    if (soc.twitterMentions24h) sParts.push(`${soc.twitterMentions24h} tweets/24h`);
    if (sParts.length) { lines.push(`🌐  ${sParts.join('  ·  ')}`); sep(); }
  }

  /* ── SMART MONEY ────────────────────────────────────────────────────────── */
  if (sm?.holdersFound && sm.holdersFound > 0) {
    const wallets = sm.holders.slice(0, 2).map(h => esc(h.label)).join(', ');
    lines.push(`🐋 Smart money: <b>${sm.holdersFound}</b> known wallet${sm.holdersFound > 1 ? 's' : ''}`);
    if (wallets) lines.push(`<i>${wallets}</i>`);
    sep();
  }

  /* ── AI VERDICT (or playbook fallback) ─────────────────────────────────── */
  if (ai) {
    const v = VERDICT[ai.verdict];
    lines.push(`━━━━━━━━━━━━━━━━━━`);
    lines.push(`${v.icon} <b>${v.label}</b>  ·  Score <b>${ai.score}/100</b>`);

    // Category breakdown compact
    const cs = ai.categoryScores;
    lines.push(
      `<i>Safety ${cs.safety}  Dist ${cs.distribution}  Market ${cs.market}  Social ${cs.social}</i>`,
    );

    // Signals
    if (ai.bullishSignals.length) {
      ai.bullishSignals.slice(0, 3).forEach(sig => lines.push(`↗ ${esc(sig)}`));
    }
    if (ai.riskFactors.length) {
      ai.riskFactors.slice(0, 2).forEach(sig => lines.push(`↘ ${esc(sig)}`));
    }

    // Contradictions surface cross-signal conflicts
    if (ai.contradictions?.length) {
      ai.contradictions.slice(0, 2).forEach(c => lines.push(`⚡ ${esc(c)}`));
    }

    // Summary — bigger window so it reads like a real trading note
    if (ai.summary) lines.push(`\n<i>${esc(ai.summary.slice(0, 700))}${ai.summary.length > 700 ? '…' : ''}</i>`);

    if (ai.exitSizing) lines.push(`\n💰 ${esc(ai.exitSizing)}`);
    lines.push(`━━━━━━━━━━━━━━━━━━`);

  } else {
    // Playbook fallback (no AI)
    const top = report.playbooks
      .filter(p => p.verdict !== 'insufficient_data' && p.score != null)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];

    if (top) {
      const vIcon: Record<string, string> = {
        strong_yes: '🚀', yes: '📈', neutral: '⚖️', no: '⏭', strong_no: '🚨',
      };
      lines.push(`${vIcon[top.verdict] ?? '•'} <b>${esc(top.label)}</b>: ${top.verdict.replace('_', ' ').toUpperCase()}`);
      if (top.signals.length) {
        top.signals.slice(0, 2).forEach(sig =>
          lines.push(`${sig.weight === 'positive' ? '↗' : sig.weight === 'negative' ? '↘' : '·'} ${esc(sig.label)}`),
        );
      }
    }
    lines.push(`\n🔐 <i>Full AI analysis + trading strategy</i>`);
  }

  /* ── CTA ────────────────────────────────────────────────────────────────── */
  sep();
  const deepLink = `${webUrl}/intel?address=${encodeURIComponent(address)}&profile=meme_hunter`;
  lines.push(`⚡ <a href="${deepLink}">Full Report + Strategy →</a>`);

  /* ── Keyboard ───────────────────────────────────────────────────────────── */
  const keyboard = new InlineKeyboard()
    .url('🔍 Full Report', deepLink);

  if (m.url) {
    keyboard.url('📊 Chart', m.url);
  }

  return { text: lines.join('\n'), keyboard };
}

/* ─── Scanning placeholder ──────────────────────────────────────────────────── */
export function formatPlaceholder(address: string): string {
  const short = address.slice(0, 8) + '…' + address.slice(-4);
  return `🔍 <b>Scanning</b>  <code>${short}</code>\n⏳ Fetching market data + safety signals…`;
}

/* ─── HTML escape ───────────────────────────────────────────────────────────── */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
