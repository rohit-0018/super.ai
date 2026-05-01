'use client';
import { useState, useEffect, useCallback, Suspense } from 'react';
import type { ReactNode } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { api } from '../../lib/api';

/* ─── Types ──────────────────────────────────────────────────────────────── */
type Chain = 'SOLANA' | 'EVM';
type AiVerdict = 'STRONG_BUY' | 'BUY' | 'CAUTIOUS' | 'SKIP' | 'HIGH_RISK';
type PbVerdict = 'strong_yes' | 'yes' | 'neutral' | 'no' | 'strong_no' | 'insufficient_data';

interface Signal { label: string; weight: 'critical' | 'positive' | 'negative' | 'info'; detail?: string }
interface Playbook {
  key: string; label: string; description: string;
  score: number | null; verdict: PbVerdict; signals: Signal[];
  plan?: { sizeHint: string; entry: string; stop: string; targets: string[]; notes?: string };
}
interface Report {
  meta: {
    chain: Chain; address: string; symbol?: string; name?: string; chainId?: string;
    priceUsd?: number; marketCapUsd?: number; fdvUsd?: number; liquidityUsd?: number;
    volume24hUsd?: number; priceChange: { m5?: number; h1?: number; h6?: number; h24?: number };
    txns24h?: { buys?: number; sells?: number }; pairAgeHours?: number; dex?: string; url?: string;
    socials?: Array<{ type: string; url: string }>;
    websites?: Array<{ label: string; url: string }>;
  };
  safety: {
    honeypot?: 'yes' | 'no' | 'unknown'; buyTax?: number; sellTax?: number;
    mintAuthority?: boolean; freezeAuthority?: boolean;
    lpLocked?: 'yes' | 'no' | 'unknown'; topHoldersPct?: number; holdersCount?: number;
    rugScore?: number; flags: string[];
  };
  playbooks: Playbook[];
  generatedAt: string; cacheTtlSec: number;
  providers: Array<{ name: string; status: 'hit' | 'miss' | 'error' | 'skipped'; note?: string }>;
  disclaimer: string;
  kill?: { triggered: boolean; reason?: string };
  holderMetrics?: { totalHolders?: number; top10ConcentrationPct?: number; deployerHoldsPct?: number; bundleDetected?: boolean };
  socialData?: { twitterUrl?: string; telegramUrl?: string; websiteUrl?: string; telegramMembers?: number; domainAgeDays?: number; hasSocials: boolean };
  smartMoney?: { walletsChecked: number; holdersFound: number; holders: Array<{ label: string }> };
  aiReasoning?: {
    score: number; verdict: AiVerdict;
    categoryScores: { safety: number; market: number; holders: number; social: number; momentum: number };
    categoryReasons?: { safety?: string; market?: string; holders?: string; social?: string; momentum?: string };
    bullishSignals: string[]; riskFactors: string[]; summary: string; generatedAt: string;
  };
}

interface HistoryEntry {
  address: string; symbol?: string; name?: string; chain: string; dex?: string;
  priceUsd?: number; h24?: number; verdict: string; score: number; source: 'ai' | 'playbooks';
  liquidityUsd?: number; marketCapUsd?: number; killed: boolean; timestamp: number;
}

/* ─── Formatters ─────────────────────────────────────────────────────────── */
const fmtUsd = (n?: number) => n == null ? '—' : n >= 1e9 ? `$${(n/1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n/1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n/1e3).toFixed(1)}K` : `$${n.toFixed(2)}`;
const fmtPrice = (n?: number) => n == null ? '—' : n >= 1000 ? `$${n.toLocaleString(undefined,{maximumFractionDigits:0})}` : n >= 1 ? `$${n.toFixed(4)}` : n >= 0.001 ? `$${n.toFixed(6)}` : n >= 0.000001 ? `$${n.toFixed(8)}` : `$${n.toExponential(3)}`;
const fmtPct = (n?: number) => n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
const fmtAge = (h?: number) => h == null ? '—' : h < 1 ? `${Math.round(h*60)}m` : h < 24 ? `${h.toFixed(1)}h` : `${(h/24).toFixed(1)}d`;
const fmtTax = (bps?: number) => bps == null ? '—' : `${(bps/100).toFixed(1)}%`;
const timeAgo = (ts: number) => { const m = Math.floor((Date.now()-ts)/60000); if(m<1) return 'just now'; if(m<60) return `${m}m ago`; const h=Math.floor(m/60); if(h<24) return `${h}h ago`; return `${Math.floor(h/24)}d ago`; };

/* ─── Verdict helpers ────────────────────────────────────────────────────── */
const VERDICT_COLOR: Record<string,string> = { STRONG_BUY:'#22c55e', BUY:'#4ade80', CAUTIOUS:'#f59e0b', SKIP:'#94a3b8', HIGH_RISK:'#ef4444' };
const VERDICT_ICON: Record<string,string> = { STRONG_BUY:'🏆', BUY:'✅', CAUTIOUS:'⚠️', SKIP:'⏭', HIGH_RISK:'🚨' };
const VERDICT_LABEL: Record<string,string> = { STRONG_BUY:'STRONG BUY', BUY:'BUY', CAUTIOUS:'CAUTIOUS', SKIP:'SKIP', HIGH_RISK:'HIGH RISK' };
const PB_ICON: Record<string,string> = { strong_yes:'🏆', yes:'✅', neutral:'⚠️', no:'❌', strong_no:'🚫', insufficient_data:'❓' };
const PB_LABEL: Record<string,string> = { strong_yes:'STRONG YES', yes:'YES', neutral:'CAUTIOUS', no:'NO', strong_no:'AVOID', insufficient_data:'NO DATA' };
const PB_COLOR: Record<string,string> = { strong_yes:'#22c55e', yes:'#4ade80', neutral:'#f59e0b', no:'#ef4444', strong_no:'#dc2626', insufficient_data:'#94a3b8' };

const vc = (v: string) => VERDICT_COLOR[v] ?? '#94a3b8';
const vi = (v: string) => VERDICT_ICON[v] ?? '❓';
const vl = (v: string) => VERDICT_LABEL[v] ?? v;
const pctColor = (n?: number) => n == null ? 'var(--text-3)' : n >= 0 ? '#4ade80' : '#ef4444';

/* ─── Compute overall verdict ────────────────────────────────────────────── */
function computeOverall(report: Report): { score: number; verdict: string; source: 'ai' | 'playbooks' } {
  if (report.aiReasoning) {
    return { score: report.aiReasoning.score, verdict: report.aiReasoning.verdict, source: 'ai' };
  }
  const { safety, playbooks, kill } = report;
  const scored = playbooks.filter(pb => pb.score != null && pb.verdict !== 'insufficient_data');
  let base = scored.length
    ? scored.reduce((s, pb) => s + pb.score! * 10, 0) / scored.length
    : 50;
  if (safety.honeypot === 'yes') base -= 45;
  if (kill?.triggered) base -= 50;
  if (safety.mintAuthority) base -= 12;
  if (safety.freezeAuthority) base -= 8;
  if (safety.lpLocked === 'no') base -= 10;
  if ((safety.rugScore ?? 0) > 70) base -= 22;
  else if ((safety.rugScore ?? 0) > 40) base -= 10;
  if (safety.flags.length > 3) base -= 8;
  const score = Math.max(0, Math.min(100, Math.round(base)));
  const verdict = score >= 80 ? 'STRONG_BUY' : score >= 65 ? 'BUY' : score >= 50 ? 'CAUTIOUS' : score >= 30 ? 'SKIP' : 'HIGH_RISK';
  return { score, verdict, source: 'playbooks' };
}

/* ─── Score ring ─────────────────────────────────────────────────────────── */
function ScoreRing({ score, size = 100, strokeW = 9 }: { score: number; size?: number; strokeW?: number }) {
  const r = (size - strokeW) / 2;
  const circ = 2 * Math.PI * r;
  const fill = Math.max(0, Math.min(1, score / 100)) * circ;
  const color = vc(score >= 80 ? 'STRONG_BUY' : score >= 65 ? 'BUY' : score >= 50 ? 'CAUTIOUS' : score >= 30 ? 'SKIP' : 'HIGH_RISK');
  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)', display: 'block', flexShrink: 0 }}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={strokeW} />
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={strokeW}
        strokeDasharray={`${fill} ${circ-fill}`} strokeLinecap="round"
        style={{ transition: 'stroke-dasharray 0.7s ease' }} />
    </svg>
  );
}

/* ─── localStorage history ───────────────────────────────────────────────── */
const HIST_KEY = 'qwai_intel_history';
const MAX_HIST = 25;

function loadHistory(): HistoryEntry[] {
  try { return JSON.parse(localStorage.getItem(HIST_KEY) ?? '[]'); } catch { return []; }
}
function saveHistory(report: Report) {
  try {
    const ov = computeOverall(report);
    const entry: HistoryEntry = {
      address: report.meta.address, symbol: report.meta.symbol, name: report.meta.name,
      chain: report.meta.chain, dex: report.meta.dex, priceUsd: report.meta.priceUsd,
      h24: report.meta.priceChange.h24, verdict: ov.verdict, score: ov.score, source: ov.source,
      liquidityUsd: report.meta.liquidityUsd, marketCapUsd: report.meta.marketCapUsd,
      killed: !!report.kill?.triggered, timestamp: Date.now(),
    };
    const prev = loadHistory().filter(h => h.address !== report.meta.address);
    localStorage.setItem(HIST_KEY, JSON.stringify([entry, ...prev].slice(0, MAX_HIST)));
  } catch {}
}

/* ─── History sidebar ────────────────────────────────────────────────────── */
function HistorySidebar({ onAnalyze, currentAddr }: { onAnalyze: (addr: string, force?: boolean) => void; currentAddr?: string }) {
  const [open, setOpen] = useState(true);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => { setHistory(loadHistory()); }, [currentAddr]);

  const clearAll = () => { localStorage.removeItem(HIST_KEY); setHistory([]); };

  if (!open) {
    return (
      <div style={{ width: 40, flexShrink: 0, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 12, gap: 8 }}>
        <button onClick={() => setOpen(true)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', fontSize: 16, padding: 6 }} title="Open history">
          ▶
        </button>
        {history.slice(0, 8).map(h => (
          <button key={h.address} onClick={() => { setOpen(true); onAnalyze(h.address); }}
            style={{ width: 28, height: 28, borderRadius: 6, border: 'none', cursor: 'pointer', background: `${vc(h.verdict)}25`, fontSize: 10, fontWeight: 700, color: vc(h.verdict), fontFamily: 'var(--font-mono)' }}
            title={h.symbol ?? h.address.slice(0,6)}>
            {h.score}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div style={{ width: 260, flexShrink: 0, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', background: 'var(--bg-2)', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-2)', letterSpacing: '0.12em', textTransform: 'uppercase', flex: 1 }}>🕒 Recent Scans</span>
        {history.length > 0 && (
          <button onClick={clearAll} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', fontSize: 11, padding: '2px 4px' }} title="Clear history">✕</button>
        )}
        <button onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', fontSize: 14, padding: '2px 4px' }}>◀</button>
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {history.length === 0 && (
          <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--text-3)', fontSize: 12 }}>
            No scans yet.<br />Analyze a token to build history.
          </div>
        )}
        {history.map(h => {
          const isExpanded = expanded === h.address;
          const isCurrent = h.address === currentAddr;
          const color = vc(h.verdict);
          return (
            <div key={h.address} style={{ borderBottom: '1px solid var(--border)', background: isCurrent ? 'rgba(59,130,246,0.06)' : 'transparent' }}>
              {/* Collapsed row */}
              <button
                onClick={() => setExpanded(isExpanded ? null : h.address)}
                style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer', padding: '9px 12px', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 8 }}
              >
                {/* Verdict dot */}
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
                {/* Symbol + chain */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 2 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {h.symbol ?? h.address.slice(0, 8)}
                    </span>
                    <span style={{ fontSize: 9, color: 'var(--text-3)', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>{h.chain}</span>
                    {isCurrent && <span style={{ fontSize: 8, color: 'var(--accent)', fontWeight: 700, flexShrink: 0 }}>●</span>}
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-2)', fontFeatureSettings: '"tnum" 1' }}>{fmtPrice(h.priceUsd)}</span>
                    {h.h24 != null && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: pctColor(h.h24), fontFeatureSettings: '"tnum" 1' }}>{fmtPct(h.h24)}</span>}
                  </div>
                </div>
                {/* Score + verdict */}
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 15, fontWeight: 800, color, lineHeight: 1 }}>{h.score}</div>
                  <div style={{ fontSize: 9, color, fontWeight: 700, letterSpacing: '0.06em' }}>{vl(h.verdict).split(' ')[0]}</div>
                </div>
                <span style={{ fontSize: 10, color: 'var(--text-3)', transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▼</span>
              </button>

              {/* Expanded */}
              {isExpanded && (
                <div style={{ padding: '0 12px 10px', borderTop: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 10, color: 'var(--text-3)', marginBottom: 6, paddingTop: 8 }}>{timeAgo(h.timestamp)}{h.killed ? ' · 🚨 KILL' : ''}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px 10px', marginBottom: 8, fontSize: 11 }}>
                    <span style={{ color: 'var(--text-3)' }}>MCap</span><span style={{ color: 'var(--text)', fontFamily: 'var(--font-mono)', textAlign: 'right' }}>{fmtUsd(h.marketCapUsd)}</span>
                    <span style={{ color: 'var(--text-3)' }}>Liq</span><span style={{ color: 'var(--text)', fontFamily: 'var(--font-mono)', textAlign: 'right' }}>{fmtUsd(h.liquidityUsd)}</span>
                    <span style={{ color: 'var(--text-3)' }}>Source</span><span style={{ color: h.source === 'ai' ? 'var(--accent-2)' : 'var(--text-2)', textAlign: 'right', fontWeight: 600 }}>{h.source === 'ai' ? '🤖 AI' : '📊 Playbooks'}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => onAnalyze(h.address)} className="btn btn-primary btn-sm" style={{ flex: 1, fontSize: 11, height: 28 }}>
                      View
                    </button>
                    <button onClick={() => onAnalyze(h.address, true)} className="btn btn-ghost btn-sm" style={{ fontSize: 11, height: 28, padding: '0 8px' }} title="Force re-analyze">
                      🔄
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─── Overall verdict card ───────────────────────────────────────────────── */
function OverallVerdictCard({ report }: { report: Report }) {
  const overall = computeOverall(report);
  const ai = report.aiReasoning;
  const color = vc(overall.verdict);
  const buys = report.meta.txns24h?.buys ?? 0, sells = report.meta.txns24h?.sells ?? 0, total = buys + sells;
  const buyPct = total > 0 ? Math.round((buys/total)*100) : null;
  const liq = report.meta.liquidityUsd;
  const safeOk = report.safety.honeypot !== 'yes' && !report.kill?.triggered && (report.safety.rugScore ?? 0) < 60;
  const pbs = report.playbooks.filter(pb => pb.verdict !== 'insufficient_data');
  const pbYes = pbs.filter(pb => pb.verdict === 'yes' || pb.verdict === 'strong_yes').length;

  const cats = ai ? [
    { label: 'Safety', score: ai.categoryScores.safety, max: 30 },
    { label: 'Market', score: ai.categoryScores.market, max: 20 },
    { label: 'Holders', score: ai.categoryScores.holders, max: 20 },
    { label: 'Social', score: ai.categoryScores.social, max: 15 },
    { label: 'Momentum', score: ai.categoryScores.momentum, max: 15 },
  ] : null;

  return (
    <div style={{
      background: `linear-gradient(135deg, ${color}10 0%, var(--surface) 60%)`,
      border: `1px solid ${color}40`,
      borderRadius: 14,
      boxShadow: `0 0 32px ${color}12, inset 0 1px 0 rgba(255,255,255,0.06)`,
      overflow: 'hidden',
    }}>
      {/* Main verdict */}
      <div style={{ display: 'flex', gap: 24, padding: '20px 24px', alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <ScoreRing score={overall.score} size={110} strokeW={10} />
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 28, fontWeight: 900, lineHeight: 1, color, fontFeatureSettings: '"tnum" 1' }}>{overall.score}</span>
            <span style={{ fontSize: 9, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>/100</span>
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 6 }}>
            Overall Verdict {overall.source === 'ai' ? '· 🤖 Claude AI' : '· 📊 Playbooks'}
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 38, fontWeight: 900, color, lineHeight: 1, letterSpacing: '0.01em' }}>
            {vi(overall.verdict)} {vl(overall.verdict)}
          </div>
          <div style={{ display: 'flex', gap: 12, marginTop: 10, flexWrap: 'wrap' }}>
            {safeOk && <span style={{ fontSize: 12, fontWeight: 600, color: '#4ade80' }}>🛡️ Safety OK</span>}
            {!safeOk && <span style={{ fontSize: 12, fontWeight: 600, color: '#ef4444' }}>🚨 Safety Risk</span>}
            {buyPct != null && <span style={{ fontSize: 12, fontWeight: 600, color: buyPct >= 55 ? '#4ade80' : '#f59e0b' }}>💰 {buyPct}% Buys</span>}
            {liq != null && <span style={{ fontSize: 12, fontWeight: 600, color: liq > 100000 ? '#4ade80' : liq > 30000 ? '#f59e0b' : '#ef4444' }}>💧 Liq {fmtUsd(liq)}</span>}
            {pbs.length > 0 && <span style={{ fontSize: 12, fontWeight: 600, color: pbYes >= 2 ? '#4ade80' : '#f59e0b' }}>🎯 {pbYes}/{pbs.length} Playbooks YES</span>}
          </div>
        </div>

        {/* Category mini bars (AI only) */}
        {cats && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 180 }}>
            {cats.map(cat => {
              const pct = (cat.score / cat.max) * 100;
              const barColor = pct >= 70 ? '#4ade80' : pct >= 40 ? '#f59e0b' : '#ef4444';
              return (
                <div key={cat.label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)', width: 68, flexShrink: 0 }}>{cat.label}</span>
                  <div style={{ flex: 1, height: 5, background: 'rgba(255,255,255,0.06)', borderRadius: 3 }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: barColor, borderRadius: 3, transition: 'width 0.6s ease' }} />
                  </div>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: barColor, width: 36, textAlign: 'right', flexShrink: 0 }}>{cat.score}/{cat.max}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Kill banner */}
      {report.kill?.triggered && (
        <div style={{ padding: '10px 24px', background: 'rgba(239,68,68,0.15)', borderTop: '1px solid rgba(239,68,68,0.3)', fontSize: 13, fontWeight: 600, color: '#ef4444' }}>
          🚨 Kill switch triggered — {report.kill.reason}
        </div>
      )}

      {/* AI summary */}
      {ai?.summary && (
        <div style={{ padding: '14px 24px', borderTop: '1px solid rgba(255,255,255,0.06)', background: 'rgba(168,85,247,0.05)' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent-2)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 8 }}>🤖 Trader Take</div>
          <p style={{ fontSize: 14, fontWeight: 500, lineHeight: 1.75, color: 'var(--text)', margin: 0 }}>{ai.summary}</p>
        </div>
      )}

      {/* Playbook quick row */}
      {pbs.length > 0 && (
        <div style={{ padding: '10px 24px', borderTop: '1px solid rgba(255,255,255,0.06)', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {pbs.map(pb => (
            <span key={pb.key} style={{ fontSize: 12, fontWeight: 600, color: PB_COLOR[pb.verdict] ?? '#94a3b8', background: `${PB_COLOR[pb.verdict] ?? '#94a3b8'}15`, padding: '3px 9px', borderRadius: 20, border: `1px solid ${PB_COLOR[pb.verdict] ?? '#94a3b8'}30` }}>
              {PB_ICON[pb.verdict]} {pb.label} {pb.score != null ? `${pb.score.toFixed(1)}` : ''}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Token header ───────────────────────────────────────────────────────── */
function TokenHeader({ report, onReanalyze, busy }: { report: Report; onReanalyze: () => void; busy: boolean }) {
  const { meta } = report;
  const h24 = meta.priceChange.h24, h1 = meta.priceChange.h1, h6 = meta.priceChange.h6;
  const buys = meta.txns24h?.buys ?? 0, sells = meta.txns24h?.sells ?? 0, total = buys + sells;
  const buyPct = total > 0 ? Math.round((buys/total)*100) : null;
  const volMcap = meta.volume24hUsd && meta.marketCapUsd && meta.marketCapUsd > 0 ? Math.round((meta.volume24hUsd/meta.marketCapUsd)*100) : null;

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 18px', boxShadow: 'inset 0 1px 0 var(--highlight)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 800, letterSpacing: '-0.025em' }}>
          {meta.symbol ?? meta.address.slice(0,8)}
        </span>
        {meta.name && meta.name !== meta.symbol && <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-3)' }}>{meta.name}</span>}
        <span className="chip" style={{ fontSize: 11, fontWeight: 700 }}>{meta.chain}</span>
        {meta.dex && <span className="chip chip-accent" style={{ fontSize: 11, fontWeight: 700 }}>{meta.dex}</span>}
        {meta.pairAgeHours != null && <span className="chip" style={{ fontSize: 11 }}>⏰ {fmtAge(meta.pairAgeHours)}</span>}
        {report.kill?.triggered && <span className="chip chip-bad" style={{ fontSize: 11, fontWeight: 700 }}>🚨 KILL</span>}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button onClick={onReanalyze} disabled={busy} className="btn btn-ghost btn-sm" style={{ fontSize: 11, height: 30 }}>
            {busy ? '⏳ Refreshing…' : '🔄 Re-analyze'}
          </button>
          {meta.url && <a href={meta.url} target="_blank" rel="noopener noreferrer" className="btn btn-ghost btn-sm" style={{ fontSize: 11, height: 30 }}>📊 Chart ↗</a>}
          {meta.websites?.[0]?.url && <a href={meta.websites[0].url} target="_blank" rel="noopener noreferrer" className="btn btn-ghost btn-sm" style={{ fontSize: 11, height: 30 }}>🌐 Site ↗</a>}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, marginBottom: 10, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 30, fontWeight: 900, letterSpacing: '-0.02em', fontFeatureSettings: '"tnum" 1' }}>{fmtPrice(meta.priceUsd)}</span>
        {h24 != null && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 17, fontWeight: 700, color: pctColor(h24) }}>{h24 >= 0 ? '📈' : '📉'} {fmtPct(h24)} 24h</span>}
        {h1 != null && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 600, color: pctColor(h1) }}>{fmtPct(h1)} 1h</span>}
        {h6 != null && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 600, color: pctColor(h6) }}>{fmtPct(h6)} 6h</span>}
      </div>

      <div style={{ display: 'flex', gap: '6px 22px', flexWrap: 'wrap' }}>
        {[
          { l: '💎 MCap', v: fmtUsd(meta.marketCapUsd) },
          { l: '💧 Liq', v: fmtUsd(meta.liquidityUsd), c: meta.liquidityUsd != null ? (meta.liquidityUsd > 100000 ? '#4ade80' : meta.liquidityUsd > 30000 ? '#f59e0b' : '#ef4444') : undefined },
          { l: '📊 Vol 24h', v: fmtUsd(meta.volume24hUsd) },
          ...(volMcap != null ? [{ l: '🔄 Vol/MCap', v: `${volMcap}%`, c: volMcap > 20 ? '#4ade80' : undefined }] : []),
          ...(buyPct != null ? [{ l: '💰 Buys', v: `${buyPct}% (${buys}B/${sells}S)`, c: buyPct >= 55 ? '#4ade80' : buyPct <= 35 ? '#ef4444' : '#f59e0b' }] : []),
        ].map(({ l, v, c }) => (
          <div key={l} style={{ display: 'flex', gap: 5, alignItems: 'baseline' }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)' }}>{l}</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 700, fontFeatureSettings: '"tnum" 1', color: (c as any) ?? 'var(--text)' }}>{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── AI breakdown card ──────────────────────────────────────────────────── */
function AIBreakdownCard({ report }: { report: Report }) {
  const ai = report.aiReasoning;
  if (!ai) return null;

  const cats = [
    { key: 'safety' as const, label: '🛡️ Safety', max: 30 },
    { key: 'market' as const, label: '📊 Market', max: 20 },
    { key: 'holders' as const, label: '👥 Holders', max: 20 },
    { key: 'social' as const, label: '📱 Social', max: 15 },
    { key: 'momentum' as const, label: '⚡ Momentum', max: 15 },
  ];

  return (
    <div className="section">
      <div className="section-header">
        <h3 className="section-title" style={{ fontSize: 14 }}>🤖 AI Score Breakdown <span style={{ fontSize: 11, color: 'var(--accent-2)', fontWeight: 500, marginLeft: 6 }}>Claude · {new Date(ai.generatedAt).toLocaleTimeString()}</span></h3>
      </div>
      <div className="section-body" style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {cats.map(({ key, label, max }) => {
          const score = ai.categoryScores[key];
          const reason = ai.categoryReasons?.[key];
          const pct = (score / max) * 100;
          const barColor = pct >= 70 ? '#4ade80' : pct >= 40 ? '#f59e0b' : '#ef4444';
          return (
            <div key={key}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: reason ? 5 : 0 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-2)', width: 110, flexShrink: 0 }}>{label}</span>
                <div style={{ flex: 1, height: 7, background: 'rgba(255,255,255,0.06)', borderRadius: 4 }}>
                  <div style={{ width: `${pct}%`, height: '100%', background: barColor, borderRadius: 4, transition: 'width 0.6s ease' }} />
                </div>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 700, color: barColor, width: 42, textAlign: 'right', flexShrink: 0 }}>{score}/{max}</span>
              </div>
              {reason && <div style={{ marginLeft: 120, fontSize: 12, fontWeight: 500, color: 'var(--text-3)', lineHeight: 1.6 }}>{reason}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─── Data row ───────────────────────────────────────────────────────────── */
function Row({ label, value, color, mono = true }: { label: string; value: string; color?: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '7px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-3)', flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 14, fontWeight: 600, fontFamily: mono ? 'var(--font-mono)' : 'inherit', fontFeatureSettings: '"tnum" 1', color: color ?? 'var(--text)', textAlign: 'right', maxWidth: '58%' }}>{value}</span>
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="section">
      <div className="section-header"><h3 className="section-title" style={{ fontSize: 14 }}>{title}</h3></div>
      <div className="section-body" style={{ padding: '10px 16px' }}>{children}</div>
    </div>
  );
}

/* ─── Safety ─────────────────────────────────────────────────────────────── */
function SafetyCard({ report }: { report: Report }) {
  const { safety, aiReasoning } = report;
  const checks = [safety.honeypot==='no', safety.mintAuthority===false, safety.freezeAuthority===false, safety.lpLocked==='yes', (safety.rugScore??100)<40];
  const pass = checks.filter(Boolean).length;
  const barColor = pass>=4 ? '#4ade80' : pass>=2 ? '#f59e0b' : '#ef4444';
  const status = pass>=4 ? '🟢 CLEAN' : pass>=2 ? '🟡 CAUTION' : '🔴 RISKY';
  return (
    <Card title={`🛡️ Safety Check — ${status}`}>
      {aiReasoning?.categoryReasons?.safety && <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-3)', lineHeight: 1.6, marginBottom: 10, padding: '8px 10px', background: 'rgba(168,85,247,0.07)', borderRadius: 6, borderLeft: '2px solid var(--accent-2)' }}>{aiReasoning.categoryReasons.safety}</div>}
      <Row label="🍯 Honeypot" value={safety.honeypot==='no'?'🟢 Not a honeypot':safety.honeypot==='yes'?'🔴 HONEYPOT!':'❓ Unknown'} color={safety.honeypot==='no'?'#4ade80':safety.honeypot==='yes'?'#ef4444':'#f59e0b'} mono={false} />
      <Row label="🪙 Mint authority" value={safety.mintAuthority==null?'❓ Unknown':safety.mintAuthority?'🔴 ACTIVE':'🟢 Revoked'} color={safety.mintAuthority==null?'#94a3b8':safety.mintAuthority?'#ef4444':'#4ade80'} mono={false} />
      <Row label="🧊 Freeze authority" value={safety.freezeAuthority==null?'❓ Unknown':safety.freezeAuthority?'🔴 ACTIVE':'🟢 Revoked'} color={safety.freezeAuthority==null?'#94a3b8':safety.freezeAuthority?'#ef4444':'#4ade80'} mono={false} />
      <Row label="🔒 LP locked" value={safety.lpLocked==='yes'?'🟢 Locked':safety.lpLocked==='no'?'🔴 Unlocked':'❓ Unknown'} color={safety.lpLocked==='yes'?'#4ade80':safety.lpLocked==='no'?'#ef4444':'#f59e0b'} mono={false} />
      <Row label="💳 Buy tax" value={safety.buyTax!=null?(safety.buyTax===0?`🟢 ${fmtTax(safety.buyTax)}`:`🟡 ${fmtTax(safety.buyTax)}`):' —'} color={safety.buyTax!=null&&safety.buyTax>500?'#ef4444':'#4ade80'} mono={false} />
      <Row label="💳 Sell tax" value={safety.sellTax!=null?(safety.sellTax===0?`🟢 ${fmtTax(safety.sellTax)}`:`🟡 ${fmtTax(safety.sellTax)}`):' —'} color={safety.sellTax!=null&&safety.sellTax>500?'#ef4444':'#4ade80'} mono={false} />
      <Row label="📊 Rug score" value={safety.rugScore!=null?`${safety.rugScore}/100 ${safety.rugScore>60?'🔴':safety.rugScore>30?'🟡':'🟢'}`:'—'} color={(safety.rugScore??0)>60?'#ef4444':(safety.rugScore??0)>30?'#f59e0b':'#4ade80'} />
      {safety.holdersCount!=null && <Row label="👤 Holders" value={safety.holdersCount.toLocaleString()} />}
      {safety.flags.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#ef4444', marginBottom: 4 }}>🚩 {safety.flags.length} Flag{safety.flags.length>1?'s':''}</div>
          {safety.flags.map((f,i) => <div key={i} style={{ fontSize: 12, fontWeight: 500, color: '#f87171', padding: '3px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>· {f}</div>)}
        </div>
      )}
      <div style={{ marginTop: 12, padding: '8px 12px', background: `${barColor}15`, borderRadius: 8, fontSize: 13, fontWeight: 700, color: barColor, textAlign: 'center', border: `1px solid ${barColor}30` }}>
        {pass>=4?'✅ Passes all critical safety checks':pass>=2?'⚠️ Some concerns — proceed carefully':'🚨 Multiple red flags — high risk'}
      </div>
    </Card>
  );
}

/* ─── Market ─────────────────────────────────────────────────────────────── */
function MarketCard({ report }: { report: Report }) {
  const { meta, aiReasoning } = report;
  const buys = meta.txns24h?.buys??0, sells = meta.txns24h?.sells??0, total = buys+sells;
  const buyPct = total > 0 ? Math.round((buys/total)*100) : null;
  const volMcap = meta.volume24hUsd&&meta.marketCapUsd&&meta.marketCapUsd>0 ? Math.round((meta.volume24hUsd/meta.marketCapUsd)*100) : null;
  const h24 = meta.priceChange.h24;
  return (
    <Card title={`📈 Market — ${h24==null?'NO DATA':h24>15?'🚀 PUMPING':h24>5?'🟢 BULLISH':h24<-15?'📉 DUMPING':h24<-5?'🔴 BEARISH':'🟡 NEUTRAL'}`}>
      {aiReasoning?.categoryReasons?.market && <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-3)', lineHeight: 1.6, marginBottom: 10, padding: '8px 10px', background: 'rgba(168,85,247,0.07)', borderRadius: 6, borderLeft: '2px solid var(--accent-2)' }}>{aiReasoning.categoryReasons.market}</div>}
      <Row label="💵 Price" value={fmtPrice(meta.priceUsd)} />
      <Row label="📈 5m" value={fmtPct(meta.priceChange.m5)} color={pctColor(meta.priceChange.m5)} />
      <Row label="📈 1h" value={fmtPct(meta.priceChange.h1)} color={pctColor(meta.priceChange.h1)} />
      <Row label="📈 6h" value={fmtPct(meta.priceChange.h6)} color={pctColor(meta.priceChange.h6)} />
      <Row label="📈 24h" value={fmtPct(meta.priceChange.h24)} color={pctColor(meta.priceChange.h24)} />
      <Row label="💎 MCap" value={fmtUsd(meta.marketCapUsd)} />
      <Row label="💧 Liquidity" value={fmtUsd(meta.liquidityUsd)} color={meta.liquidityUsd!=null?(meta.liquidityUsd>100000?'#4ade80':meta.liquidityUsd>30000?'#f59e0b':'#ef4444'):undefined} />
      <Row label="📊 Vol 24h" value={fmtUsd(meta.volume24hUsd)} />
      {volMcap!=null && <Row label="🔄 Vol/MCap" value={`${volMcap}% ${volMcap>20?'✅':''}`} color={volMcap>20?'#4ade80':'var(--text)'} />}
      {buyPct!=null && <Row label="💰 Buy pressure" value={`${buyPct}% (${buys}B / ${sells}S)`} color={buyPct>=60?'#4ade80':buyPct>=45?'#f59e0b':'#ef4444'} mono={false} />}
      <Row label="⏰ Pair age" value={fmtAge(meta.pairAgeHours)} />
    </Card>
  );
}

/* ─── Holders ────────────────────────────────────────────────────────────── */
function HoldersCard({ report }: { report: Report }) {
  const { safety, holderMetrics, aiReasoning } = report;
  const total = holderMetrics?.totalHolders ?? safety.holdersCount;
  const top10 = holderMetrics?.top10ConcentrationPct ?? safety.topHoldersPct;
  const bundle = holderMetrics?.bundleDetected;
  const deployer = holderMetrics?.deployerHoldsPct;
  const status = bundle===true ? '🔴 BUNDLE' : top10!=null&&top10>60 ? '🔴 WHALE HEAVY' : top10!=null&&top10>35 ? '🟡 MODERATE' : '🟢 HEALTHY';
  return (
    <Card title={`👥 Holders — ${status}`}>
      {aiReasoning?.categoryReasons?.holders && <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-3)', lineHeight: 1.6, marginBottom: 10, padding: '8px 10px', background: 'rgba(168,85,247,0.07)', borderRadius: 6, borderLeft: '2px solid var(--accent-2)' }}>{aiReasoning.categoryReasons.holders}</div>}
      <Row label="👤 Total holders" value={total!=null?total.toLocaleString():'—'} color={total!=null&&total>1000?'#4ade80':'var(--text)'} />
      <Row label="🐋 Top 10 concentration" value={top10!=null?`${top10.toFixed(1)}% ${top10>60?'🔴':top10>35?'🟡':'🟢'}`:'—'} color={top10!=null?(top10>60?'#ef4444':top10>35?'#f59e0b':'#4ade80'):'#94a3b8'} mono={false} />
      <Row label="🎁 Bundle at launch" value={bundle==null?'❓ Unknown':bundle?'🔴 Bundle detected!':'🟢 None detected'} color={bundle==null?'#94a3b8':bundle?'#ef4444':'#4ade80'} mono={false} />
      <Row label="👛 Deployer holds" value={deployer!=null?`${deployer.toFixed(1)}% ${deployer>5?'⚠️':'✅'}`:'—'} color={deployer!=null?(deployer>5?'#f59e0b':'#4ade80'):'#94a3b8'} mono={false} />
      {!holderMetrics && <div style={{ marginTop: 8, fontSize: 12, fontWeight: 500, color: 'var(--text-3)', fontStyle: 'italic' }}>Set HELIUS_RPC_URL for on-chain holder analytics</div>}
    </Card>
  );
}

/* ─── Social ─────────────────────────────────────────────────────────────── */
function SocialCard({ report }: { report: Report }) {
  const { socialData, aiReasoning } = report;
  const status = !socialData ? '❓ NO DATA' : socialData.hasSocials ? '🟢 PRESENT' : '🔴 ABSENT';
  return (
    <Card title={`📱 Social — ${status}`}>
      {aiReasoning?.categoryReasons?.social && <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-3)', lineHeight: 1.6, marginBottom: 10, padding: '8px 10px', background: 'rgba(168,85,247,0.07)', borderRadius: 6, borderLeft: '2px solid var(--accent-2)' }}>{aiReasoning.categoryReasons.social}</div>}
      <Row label="𝕏 Twitter" value={socialData?.twitterUrl?'🟢 Present':'⬜ Not found'} color={socialData?.twitterUrl?'#4ade80':'#94a3b8'} mono={false} />
      <Row label="✈️ Telegram" value={socialData?.telegramUrl?'🟢 Present':'⬜ Not found'} color={socialData?.telegramUrl?'#4ade80':'#94a3b8'} mono={false} />
      <Row label="👥 Members" value={socialData?.telegramMembers!=null?`${socialData.telegramMembers.toLocaleString()} ${socialData.telegramMembers>5000?'🟢':socialData.telegramMembers>1000?'🟡':'🔴'}`:'—'} color={socialData?.telegramMembers!=null?(socialData.telegramMembers>5000?'#4ade80':socialData.telegramMembers>1000?'#f59e0b':'#ef4444'):'#94a3b8'} />
      <Row label="🌐 Website" value={socialData?.websiteUrl?'🟢 Present':'⬜ Not found'} color={socialData?.websiteUrl?'#4ade80':'#94a3b8'} mono={false} />
      <Row label="📅 Domain age" value={socialData?.domainAgeDays!=null?`${socialData.domainAgeDays}d ${socialData.domainAgeDays>90?'🟢':socialData.domainAgeDays>14?'🟡':'🔴'}`:'—'} color={socialData?.domainAgeDays!=null?(socialData.domainAgeDays>90?'#4ade80':socialData.domainAgeDays>14?'#f59e0b':'#ef4444'):'#94a3b8'} mono={false} />
    </Card>
  );
}

/* ─── Smart money ────────────────────────────────────────────────────────── */
function SmartMoneyCard({ report }: { report: Report }) {
  const { smartMoney, aiReasoning } = report;
  const hasData = smartMoney != null && smartMoney.walletsChecked > 0;
  const bullish = hasData && smartMoney!.holdersFound > 0;
  const status = !hasData ? '⬜ NOT CHECKED' : bullish ? `🟢 ${smartMoney!.holdersFound} FOUND` : '⬜ NONE HOLDING';

  return (
    <div className="section">
      <div className="section-header"><h3 className="section-title" style={{ fontSize: 14 }}>🧠 Smart Money — {status}</h3></div>
      <div className="section-body" style={{ padding: '12px 16px' }}>
        {aiReasoning?.categoryReasons?.momentum && <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-3)', lineHeight: 1.6, marginBottom: 10, padding: '8px 10px', background: 'rgba(168,85,247,0.07)', borderRadius: 6, borderLeft: '2px solid var(--accent-2)' }}>{aiReasoning.categoryReasons.momentum}</div>}

        {!hasData ? (
          <div style={{ textAlign: 'center', padding: '16px 0' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-3)', marginBottom: 6 }}>Smart money scan not available</div>
            <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-3)' }}>Only runs on Solana tokens when HELIUS_RPC_URL is configured and curated wallets list is populated.</div>
          </div>
        ) : (
          <>
            <Row label="🔍 Wallets checked" value={String(smartMoney!.walletsChecked)} />
            <Row label="💡 Smart holders" value={`${smartMoney!.holdersFound} / ${smartMoney!.walletsChecked}`} color={smartMoney!.holdersFound > 0 ? '#4ade80' : 'var(--text-2)'} />
            {smartMoney!.holders.length > 0 ? (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#4ade80', marginBottom: 6 }}>🐋 Smart wallets holding this token:</div>
                {smartMoney!.holders.map((h,i) => <div key={i} style={{ fontSize: 13, fontWeight: 600, color: '#4ade80', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>· {h.label}</div>)}
              </div>
            ) : (
              <div style={{ marginTop: 8, fontSize: 13, fontWeight: 500, color: 'var(--text-3)', fontStyle: 'italic' }}>
                No curated wallets are holding this token — absence is a signal, not a confirmation.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ─── Playbooks ──────────────────────────────────────────────────────────── */
function PlaybooksGrid({ report }: { report: Report }) {
  const pbs = report.playbooks;
  if (!pbs.length) return null;
  return (
    <div className="section">
      <div className="section-header"><h3 className="section-title" style={{ fontSize: 14 }}>🎯 Playbook Verdicts</h3></div>
      <div className="section-body" style={{ padding: '12px 16px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 10 }}>
          {pbs.map(pb => {
            const color = PB_COLOR[pb.verdict] ?? '#94a3b8';
            return (
              <div key={pb.key} style={{ padding: '13px 14px', background: 'var(--surface-2)', borderRadius: 10, border: `1px solid ${color}35` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', marginBottom: 2 }}>{pb.label}</div>
                    <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-3)' }}>{pb.description}</div>
                  </div>
                  {pb.score != null && (
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 20, fontWeight: 900, color, lineHeight: 1, flexShrink: 0, marginLeft: 8 }}>
                      {pb.score.toFixed(1)}<span style={{ fontSize: 11, color: 'var(--text-3)' }}>/10</span>
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0' }}>
                  <span style={{ fontSize: 20 }}>{PB_ICON[pb.verdict]}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 800, color }}>{PB_LABEL[pb.verdict]}</span>
                </div>
                {pb.signals.filter(s=>s.weight!=='info').slice(0,3).map((sig,i) => (
                  <div key={i} style={{ display: 'flex', gap: 6, fontSize: 12, fontWeight: 500, color: 'var(--text-3)', padding: '2px 0' }}>
                    <span style={{ color: sig.weight==='positive'?'#4ade80':sig.weight==='negative'?'#ef4444':'#f59e0b', flexShrink: 0 }}>
                      {sig.weight==='positive'?'↑':sig.weight==='negative'?'↓':'·'}
                    </span>
                    {sig.label}
                  </div>
                ))}
                {pb.plan && (
                  <div style={{ marginTop: 10, padding: '9px 10px', background: 'rgba(59,130,246,0.08)', borderRadius: 7, border: '1px solid rgba(59,130,246,0.2)', fontSize: 12, fontWeight: 500 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--accent)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 6 }}>💼 Trade Plan</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '48px 1fr', gap: '4px 8px' }}>
                      <span style={{ color: 'var(--text-3)' }}>Entry</span><span style={{ color: 'var(--text)', fontWeight: 600 }}>{pb.plan.entry}</span>
                      <span style={{ color: 'var(--text-3)' }}>Stop</span><span style={{ color: '#ef4444', fontWeight: 700 }}>{pb.plan.stop}</span>
                      <span style={{ color: 'var(--text-3)' }}>Size</span><span style={{ color: 'var(--text)' }}>{pb.plan.sizeHint}</span>
                      <span style={{ color: 'var(--text-3)' }}>Target</span><span style={{ color: '#4ade80', fontWeight: 700 }}>{pb.plan.targets.join(' → ')}</span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ─── Signals ────────────────────────────────────────────────────────────── */
function SignalsRow({ report }: { report: Report }) {
  const ai = report.aiReasoning;
  if (!ai) return null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
      <div className="section">
        <div className="section-header"><h3 className="section-title" style={{ fontSize: 14, color: '#4ade80' }}>✅ Bullish Signals</h3></div>
        <div className="section-body" style={{ padding: '8px 16px' }}>
          {ai.bullishSignals.length === 0
            ? <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-3)', padding: '4px 0' }}>None identified</div>
            : ai.bullishSignals.map((s,i) => (
              <div key={i} style={{ display: 'flex', gap: 10, padding: '7px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', fontSize: 13, fontWeight: 500 }}>
                <span style={{ color: '#4ade80', flexShrink: 0, fontSize: 15 }}>✅</span>
                <span style={{ color: 'var(--text)', lineHeight: 1.45 }}>{s}</span>
              </div>
            ))}
        </div>
      </div>
      <div className="section">
        <div className="section-header"><h3 className="section-title" style={{ fontSize: 14, color: '#ef4444' }}>⚠️ Risk Factors</h3></div>
        <div className="section-body" style={{ padding: '8px 16px' }}>
          {ai.riskFactors.length === 0
            ? <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-3)', padding: '4px 0' }}>None identified</div>
            : ai.riskFactors.map((s,i) => (
              <div key={i} style={{ display: 'flex', gap: 10, padding: '7px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', fontSize: 13, fontWeight: 500 }}>
                <span style={{ color: '#ef4444', flexShrink: 0, fontSize: 15 }}>⚠️</span>
                <span style={{ color: 'var(--text)', lineHeight: 1.45 }}>{s}</span>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

/* ─── Pipeline ───────────────────────────────────────────────────────────── */
function Pipeline({ report }: { report: Report }) {
  const [open, setOpen] = useState(false);
  const hits = report.providers.filter(p => p.status === 'hit').length;
  return (
    <div className="section">
      <button onClick={() => setOpen(o=>!o)} style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px', height: 44, borderBottom: open?'1px solid var(--border)':'none' }}>
        <h3 style={{ margin: 0, flex: 1, fontSize: 14, fontWeight: 700, color: 'var(--text)', textAlign: 'left' }}>⚙️ Data Pipeline</h3>
        <span className="chip" style={{ fontSize: 11, fontWeight: 600 }}>{hits}/{report.providers.length} providers hit</span>
        <span style={{ fontSize: 11, color: 'var(--text-3)', marginLeft: 2 }}>{open?'▲':'▼'}</span>
      </button>
      {open && (
        <div style={{ padding: '10px 16px' }}>
          {report.providers.map((p,i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', fontSize: 13, fontWeight: 500 }}>
              <span className={`chip chip-${p.status==='hit'?'ok':p.status==='error'?'bad':'warn'}`} style={{ fontSize: 10, width: 44, justifyContent: 'center', fontWeight: 700 }}>{p.status}</span>
              <span style={{ color: 'var(--text-2)', flex: 1 }}>{p.name}</span>
              {p.note && <span style={{ color: 'var(--text-3)', fontSize: 12 }}>{p.note}</span>}
            </div>
          ))}
          <div style={{ marginTop: 10, fontSize: 11, fontWeight: 500, color: 'var(--text-3)', lineHeight: 1.5 }}>{report.disclaimer}</div>
        </div>
      )}
    </div>
  );
}

/* ─── Full report ────────────────────────────────────────────────────────── */
function ReportView({ report, onReanalyze, busy }: { report: Report; onReanalyze: () => void; busy: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} className="fade-in">
      <TokenHeader report={report} onReanalyze={onReanalyze} busy={busy} />
      <OverallVerdictCard report={report} />
      {report.aiReasoning && <AIBreakdownCard report={report} />}
      <PlaybooksGrid report={report} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <SafetyCard report={report} />
        <MarketCard report={report} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <HoldersCard report={report} />
        <SocialCard report={report} />
      </div>
      <SmartMoneyCard report={report} />
      <SignalsRow report={report} />
      <Pipeline report={report} />
      <div style={{ textAlign: 'right', fontSize: 11, fontWeight: 500, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
        🕒 {new Date(report.generatedAt).toLocaleString()} · ttl {report.cacheTtlSec}s
      </div>
    </div>
  );
}

/* ─── Main page ──────────────────────────────────────────────────────────── */
function IntelPageClient() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [input, setInput] = useState(searchParams.get('address') ?? '');
  const [format, setFormat] = useState<'short'|'detailed'>('detailed');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string|null>(null);
  const [report, setReport] = useState<Report|null>(null);
  const [histKey, setHistKey] = useState(0); // bump to refresh sidebar

  const analyze = useCallback(async (addr: string, fmt: 'short'|'detailed', force = false) => {
    const trimmed = addr.trim();
    if (!trimmed) return;
    if (force) setBusy(true); else setLoading(true);
    setError(null);
    if (!force) setReport(null);
    try {
      const url = `/intel/${encodeURIComponent(trimmed)}?format=${fmt}${force?'&force=true':''}`;
      const { data } = await api.get<Report>(url);
      setReport(data);
      saveHistory(data);
      setHistKey(k => k+1);
      router.replace(`/intel?address=${encodeURIComponent(trimmed)}`, { scroll: false });
    } catch (e: any) {
      const msg = e?.response?.data?.message ?? e?.message ?? 'Analysis failed.';
      setError(typeof msg === 'string' ? msg : JSON.stringify(msg));
    } finally {
      setLoading(false);
      setBusy(false);
    }
  }, [router]);

  useEffect(() => {
    const addr = searchParams.get('address');
    if (addr) { setInput(addr); analyze(addr, 'detailed'); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleHistorySelect = useCallback((addr: string, force?: boolean) => {
    setInput(addr);
    analyze(addr, format, force ?? false);
  }, [analyze, format]);

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0, overflow: 'hidden' }}>
      {/* History sidebar */}
      <HistorySidebar key={histKey} onAnalyze={handleHistorySelect} currentAddr={report?.meta.address} />

      {/* Main area */}
      <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '20px 20px 32px' }}>
        <header style={{ marginBottom: 14 }}>
          <div className="section-eyebrow">Token Intelligence</div>
          <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em', margin: '2px 0 0' }}>🔍 Intelligence Dashboard</h1>
        </header>

        {/* Search bar */}
        <form onSubmit={e => { e.preventDefault(); analyze(input, format); }} style={{ display: 'flex', gap: 8, marginBottom: 14, alignItems: 'center' }}>
          <input
            className="input"
            placeholder="Paste token address — Solana or 0x… EVM"
            value={input}
            onChange={e => setInput(e.target.value)}
            style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 500 }}
          />
          <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', flexShrink: 0 }}>
            {(['detailed','short'] as const).map(f => (
              <button key={f} type="button" onClick={() => setFormat(f)} style={{
                padding: '0 14px', height: 32, fontSize: 11, fontWeight: 700, border: 'none', cursor: 'pointer',
                background: format===f ? 'var(--accent)' : 'var(--surface-2)',
                color: format===f ? '#fff' : 'var(--text-2)',
                textTransform: 'uppercase', letterSpacing: '0.1em', transition: 'background 0.12s',
              }}>
                {f==='detailed' ? '🤖 Full AI' : '⚡ Fast'}
              </button>
            ))}
          </div>
          <button type="submit" disabled={loading} className="btn btn-primary btn-sm" style={{ flexShrink: 0, minWidth: 90, height: 32, fontSize: 13, fontWeight: 700 }}>
            {loading ? '⏳' : '🔍 Analyze'}
          </button>
        </form>

        {loading && (
          <div className="section" style={{ padding: '40px 24px', textAlign: 'center' }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-2)', marginBottom: 10 }}>
              {format==='detailed' ? '🤖 Running full intelligence pipeline…' : '⚡ Running fast scan…'}
            </div>
            <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-3)', fontFamily: 'var(--font-mono)', lineHeight: 2 }}>
              {format==='detailed'
                ? '🔍 DexScreener → 🛡️ Safety → 👥 Holders → 📱 Social → 🧠 Smart Money → 🤖 Claude AI'
                : '🔍 DexScreener → 🛡️ Safety → 🎯 Playbooks'}
            </div>
          </div>
        )}

        {error && !loading && (
          <div style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 10, padding: '14px 18px' }}>
            <div style={{ color: '#ef4444', fontSize: 15, fontWeight: 700, marginBottom: 4 }}>🚨 Analysis failed</div>
            <div style={{ color: 'var(--text-2)', fontSize: 13, fontWeight: 500 }}>{error}</div>
          </div>
        )}

        {report && !loading && (
          <ReportView
            report={report}
            onReanalyze={() => analyze(report.meta.address, format, true)}
            busy={busy}
          />
        )}

        {!report && !loading && !error && (
          <div className="section" style={{ padding: '60px 24px', textAlign: 'center' }}>
            <div style={{ fontSize: 40, marginBottom: 14 }}>🔍</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-2)', marginBottom: 6 }}>Paste a token address above</div>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-3)', marginBottom: 16 }}>
              Solana · Ethereum · BSC · Base · Arbitrum · Optimism and more
            </div>
            <div style={{ display: 'inline-grid', gridTemplateColumns: '1fr 1fr', gap: '6px 24px', fontSize: 12, fontWeight: 500, color: 'var(--text-3)', textAlign: 'left' }}>
              <span>🤖 Full AI — DexScreener + Safety + Holders</span>
              <span>🛡️ Honeypot · LP · Mint/Freeze checks</span>
              <span>📱 Social + Smart Money scan</span>
              <span>⚡ Fast — &lt;2s without AI</span>
              <span>🎯 4 playbook verdicts with trade plans</span>
              <span>🕒 History sidebar for quick re-analysis</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function IntelPage() {
  return (
    <Suspense>
      <IntelPageClient />
    </Suspense>
  );
}
