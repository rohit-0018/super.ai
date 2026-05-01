'use client';
import { useState, useEffect, useCallback, Suspense } from 'react';
import type { ReactNode } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { api } from '../../lib/api';

/* ─── Types ──────────────────────────────────────────────────────────────── */
type TradingProfile = 'meme_hunter' | 'degen_sniper' | 'swing_trader' | 'gem_hunt' | 'alpha_hunt';
type ReportDepth = 'quick' | 'alpha' | 'dossier';
type AiVerdict = 'STRONG_BUY' | 'BUY' | 'CAUTIOUS' | 'SKIP' | 'HIGH_RISK';
type PbVerdict = 'strong_yes' | 'yes' | 'neutral' | 'no' | 'strong_no' | 'insufficient_data';

interface TradingStrategy {
  profile: string;
  profileLabel: string;
  entryPrice: number | null;
  entryZone: { low: number; high: number } | null;
  entryNote: string;
  stopLossPrice: number | null;
  stopLossPct: number;
  stopLossNote: string;
  targets: Array<{ label: string; pct: number; price: number | null; action: string }>;
  trailingStop: string;
  maxHoldTime: string;
  positionSizing: {
    pctRange: [number, number];
    portfolioNote: string;
    dollarRange: [number, number] | null;
    modifier: number;
    modifierReason: string | null;
  };
  riskReward: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  confidenceReason: string;
  warnings: string[];
}

interface ComparableToken {
  address: string;
  symbol: string | null;
  name: string | null;
  chain: string;
  marketCapUsd: number | null;
  aiScore: number | null;
  aiVerdict: string | null;
  ageHoursAtScan: number | null;
  scannedAt: string;
  url: string | null;
}

interface Signal { label: string; weight: 'critical' | 'positive' | 'negative' | 'info'; detail?: string }
interface Playbook {
  key: string; label: string; description: string;
  score: number | null; verdict: PbVerdict; signals: Signal[];
  plan?: { sizeHint: string; entry: string; stop: string; targets: string[]; notes?: string };
}

interface Report {
  meta: {
    chain: 'SOLANA' | 'EVM'; address: string; symbol?: string; name?: string; chainId?: string;
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
  holderMetrics?: {
    totalHolders?: number;
    top10ConcentrationPct?: number;
    top100ConcentrationPct?: number;
    deployerHoldsPct?: number;
    bundleDetected?: boolean;
    bundleInfo?: {
      detected: boolean; bundleCount?: number; bundledSupplyPct?: number;
      bundledWallets?: string[]; source?: string;
    };
    priceImpact?: {
      buy500Usd?: number; buy1000Usd?: number; buy5000Usd?: number;
      sell500Usd?: number; sell1000Usd?: number; sell5000Usd?: number;
    };
    lifecycle?: {
      stage: 'bonding' | 'graduated' | 'migrated' | 'mature' | 'unknown';
      bondingCurvePct?: number; launchPlatform?: string;
      graduatedAt?: string; kingOfTheHill?: boolean;
    };
    chainContext?: { tvlUsd?: number; tvl7dChangePct?: number; tvl30dChangePct?: number };
    organicScore?: number;
  };
  socialData?: {
    twitterUrl?: string; telegramUrl?: string; websiteUrl?: string;
    telegramMembers?: number; telegramActiveRate?: number;
    twitterMentions24h?: number; domainAgeDays?: number;
    websiteChanged?: boolean; hasSocials: boolean;
  };
  smartMoney?: {
    walletsChecked: number; holdersFound: number;
    holders: Array<{ label: string; address?: string; winRate?: number }>;
    signals?: Array<{ walletAddress: string; label?: string; winRate?: number; action?: string; amountUsd?: number; source?: string }>;
  };
  aiReasoning?: {
    score: number; verdict: AiVerdict;
    categoryScores: { safety: number; distribution: number; market: number; social: number; macro: number };
    categoryReasons?: { safety?: string; distribution?: string; market?: string; social?: string; macro?: string };
    contradictions?: string[];
    exitSizing?: string;
    bullishSignals: string[]; riskFactors: string[]; summary: string; generatedAt: string;
  };
  profile?: string;
  depth?: string;
  tradingStrategy?: TradingStrategy;
  comparableTokens?: ComparableToken[];
}

interface HistoryEntry {
  address: string; symbol?: string; name?: string; chain: string; dex?: string;
  priceUsd?: number; h24?: number; verdict: string; score: number; source: 'ai' | 'playbooks';
  liquidityUsd?: number; marketCapUsd?: number; killed: boolean; timestamp: number;
  profile?: string;
}

/* ─── Profile definitions (client-side mirror) ───────────────────────────── */
const PROFILES: Record<TradingProfile, { label: string; tagline: string; color: string; icon: string }> = {
  meme_hunter:  { label: 'Meme Hunter',  tagline: 'Fresh launches · pump.fun · 2–10x in hours',    color: '#f59e0b', icon: '🎯' },
  degen_sniper: { label: 'Degen Sniper', tagline: 'Bonding curve · ultra-early · sub-30min holds',  color: '#ef4444', icon: '⚡' },
  swing_trader: { label: 'Swing Trader', tagline: 'Technical setups · days–weeks · risk-managed',   color: '#3b82f6', icon: '📈' },
  gem_hunt:     { label: 'Gem Hunt',     tagline: 'Fundamentals · TVL · weeks–months holds',        color: '#22c55e', icon: '💎' },
  alpha_hunt:   { label: 'Alpha Hunt',   tagline: 'Smart money overlay · any token · copy intel',   color: '#a855f7', icon: '🔮' },
};

/* ─── Formatters ─────────────────────────────────────────────────────────── */
const fmtUsd = (n?: number | null) => !n && n !== 0 ? '—' : n >= 1e9 ? `$${(n/1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n/1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n/1e3).toFixed(1)}K` : `$${n.toFixed(2)}`;
const fmtPrice = (n?: number | null) => !n && n !== 0 ? '—' : n >= 1000 ? `$${n.toLocaleString(undefined,{maximumFractionDigits:0})}` : n >= 1 ? `$${n.toFixed(4)}` : n >= 0.001 ? `$${n.toFixed(6)}` : n >= 0.000001 ? `$${n.toFixed(8)}` : `$${n.toExponential(3)}`;
const fmtPct = (n?: number | null) => n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
const fmtAge = (h?: number | null) => h == null ? '—' : h < 1 ? `${Math.round(h*60)}m` : h < 24 ? `${h.toFixed(1)}h` : `${(h/24).toFixed(1)}d`;
const fmtTax = (bps?: number | null) => bps == null ? '—' : `${(bps/100).toFixed(1)}%`;
const timeAgo = (ts: number) => { const m = Math.floor((Date.now()-ts)/60000); if(m<1) return 'just now'; if(m<60) return `${m}m ago`; const h=Math.floor(m/60); if(h<24) return `${h}h ago`; return `${Math.floor(h/24)}d ago`; };

/* ─── Verdict helpers ────────────────────────────────────────────────────── */
const VERDICT_COLOR: Record<string,string> = { STRONG_BUY:'#22c55e', BUY:'#4ade80', CAUTIOUS:'#f59e0b', SKIP:'#94a3b8', HIGH_RISK:'#ef4444' };
const VERDICT_LABEL: Record<string,string> = { STRONG_BUY:'STRONG BUY', BUY:'BUY', CAUTIOUS:'CAUTIOUS', SKIP:'SKIP', HIGH_RISK:'HIGH RISK' };
const PB_COLOR: Record<string,string> = { strong_yes:'#22c55e', yes:'#4ade80', neutral:'#f59e0b', no:'#ef4444', strong_no:'#dc2626', insufficient_data:'#94a3b8' };
const PB_LABEL: Record<string,string> = { strong_yes:'STRONG YES', yes:'YES', neutral:'CAUTIOUS', no:'NO', strong_no:'AVOID', insufficient_data:'NO DATA' };

const vc = (v: string) => VERDICT_COLOR[v] ?? '#94a3b8';
const vl = (v: string) => VERDICT_LABEL[v] ?? v;
const pctColor = (n?: number | null) => n == null ? 'var(--text-3)' : n >= 0 ? '#4ade80' : '#ef4444';

/* ─── Compute overall verdict ────────────────────────────────────────────── */
function computeOverall(report: Report): { score: number; verdict: string; source: 'ai' | 'playbooks' } {
  if (report.aiReasoning) return { score: report.aiReasoning.score, verdict: report.aiReasoning.verdict, source: 'ai' };
  const { safety, playbooks, kill } = report;
  const scored = playbooks.filter(pb => pb.score != null && pb.verdict !== 'insufficient_data');
  let base = scored.length ? scored.reduce((s, pb) => s + pb.score! * 10, 0) / scored.length : 50;
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
  const r = (size - strokeW) / 2, circ = 2 * Math.PI * r;
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

/* ─── Profile selector ───────────────────────────────────────────────────── */
function ProfileSelector({ profile, onChange }: { profile: TradingProfile; onChange: (p: TradingProfile) => void }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {(Object.keys(PROFILES) as TradingProfile[]).map((key) => {
        const p = PROFILES[key];
        const active = key === profile;
        return (
          <button
            key={key}
            onClick={() => onChange(key)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '5px 12px', height: 30,
              background: active ? `${p.color}18` : 'var(--surface-2)',
              border: `1px solid ${active ? p.color + '60' : 'var(--border)'}`,
              borderRadius: 8, cursor: 'pointer',
              color: active ? p.color : 'var(--text-3)',
              fontSize: 12, fontWeight: active ? 700 : 500,
              transition: 'all 0.12s',
            }}
          >
            <span style={{ fontSize: 13 }}>{p.icon}</span>
            {p.label}
          </button>
        );
      })}
    </div>
  );
}

/* ─── Depth toggle ───────────────────────────────────────────────────────── */
function DepthToggle({ depth, onChange }: { depth: ReportDepth; onChange: (d: ReportDepth) => void }) {
  const opts: Array<{ key: ReportDepth; icon: string; label: string; note: string }> = [
    { key: 'quick', icon: '⚡', label: 'Quick', note: '<2s · no AI' },
    { key: 'alpha', icon: '🤖', label: 'Alpha', note: 'Full AI + strategy' },
    { key: 'dossier', icon: '📋', label: 'Dossier', note: 'Deep + comparables' },
  ];
  return (
    <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
      {opts.map(o => {
        const active = o.key === depth;
        return (
          <button
            key={o.key}
            onClick={() => onChange(o.key)}
            title={o.note}
            style={{
              padding: '0 13px', height: 30, fontSize: 11, fontWeight: active ? 700 : 500,
              border: 'none', cursor: 'pointer',
              background: active ? 'var(--accent)' : 'var(--surface-2)',
              color: active ? '#fff' : 'var(--text-2)',
              letterSpacing: '0.04em', transition: 'background 0.12s',
              display: 'flex', alignItems: 'center', gap: 5,
            }}
          >
            <span>{o.icon}</span>{o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ─── localStorage history ───────────────────────────────────────────────── */
const HIST_KEY = 'qwai_intel_history';
const PROFILE_KEY = 'qwai_profile';
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
      killed: !!report.kill?.triggered, timestamp: Date.now(), profile: report.profile,
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
        <button onClick={() => setOpen(true)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', fontSize: 16, padding: 6 }} title="Open history">▶</button>
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
    <div style={{ width: 252, flexShrink: 0, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', background: 'var(--bg-2)', overflow: 'hidden' }}>
      <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-2)', letterSpacing: '0.12em', textTransform: 'uppercase', flex: 1 }}>Recent Scans</span>
        {history.length > 0 && <button onClick={clearAll} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', fontSize: 11, padding: '2px 4px' }}>✕</button>}
        <button onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', fontSize: 14, padding: '2px 4px' }}>◀</button>
      </div>
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
          const profileMeta = h.profile ? PROFILES[h.profile as TradingProfile] : null;
          return (
            <div key={h.address} style={{ borderBottom: '1px solid var(--border)', background: isCurrent ? 'rgba(59,130,246,0.05)' : 'transparent' }}>
              <button
                onClick={() => setExpanded(isExpanded ? null : h.address)}
                style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer', padding: '9px 12px', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 8 }}
              >
                <div style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 2 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {h.symbol ?? h.address.slice(0, 8)}
                    </span>
                    <span style={{ fontSize: 9, color: 'var(--text-3)', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>{h.chain}</span>
                    {isCurrent && <span style={{ fontSize: 8, color: 'var(--accent)', fontWeight: 700, flexShrink: 0 }}>●</span>}
                  </div>
                  <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-2)', fontFeatureSettings: '"tnum" 1' }}>{fmtPrice(h.priceUsd)}</span>
                    {h.h24 != null && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: pctColor(h.h24) }}>{fmtPct(h.h24)}</span>}
                    {profileMeta && <span style={{ fontSize: 9, color: profileMeta.color, fontWeight: 600 }}>{profileMeta.icon}</span>}
                  </div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 800, color, lineHeight: 1 }}>{h.score}</div>
                  <div style={{ fontSize: 9, color, fontWeight: 700, letterSpacing: '0.05em' }}>{vl(h.verdict).split(' ')[0]}</div>
                </div>
                <span style={{ fontSize: 10, color: 'var(--text-3)', transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▼</span>
              </button>
              {isExpanded && (
                <div style={{ padding: '0 12px 10px', borderTop: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 10, color: 'var(--text-3)', marginBottom: 6, paddingTop: 8 }}>{timeAgo(h.timestamp)}{h.killed ? ' · 🚨 KILL' : ''}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px 10px', marginBottom: 8, fontSize: 11 }}>
                    <span style={{ color: 'var(--text-3)' }}>MCap</span><span style={{ color: 'var(--text)', fontFamily: 'var(--font-mono)', textAlign: 'right' }}>{fmtUsd(h.marketCapUsd)}</span>
                    <span style={{ color: 'var(--text-3)' }}>Liq</span><span style={{ color: 'var(--text)', fontFamily: 'var(--font-mono)', textAlign: 'right' }}>{fmtUsd(h.liquidityUsd)}</span>
                    <span style={{ color: 'var(--text-3)' }}>Source</span><span style={{ color: h.source === 'ai' ? 'var(--accent-2)' : 'var(--text-2)', textAlign: 'right', fontWeight: 600 }}>{h.source === 'ai' ? '🤖 AI' : '📊 Playbooks'}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => onAnalyze(h.address)} className="btn btn-primary btn-sm" style={{ flex: 1, fontSize: 11, height: 28 }}>View</button>
                    <button onClick={() => onAnalyze(h.address, true)} className="btn btn-ghost btn-sm" style={{ fontSize: 11, height: 28, padding: '0 8px' }} title="Force re-analyze">🔄</button>
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

/* ─── Token header ───────────────────────────────────────────────────────── */
function TokenHeader({ report, onReanalyze, busy, profile }: { report: Report; onReanalyze: () => void; busy: boolean; profile: TradingProfile }) {
  const { meta } = report;
  const h24 = meta.priceChange.h24, h1 = meta.priceChange.h1, h6 = meta.priceChange.h6;
  const buys = meta.txns24h?.buys ?? 0, sells = meta.txns24h?.sells ?? 0, total = buys + sells;
  const buyPct = total > 0 ? Math.round((buys/total)*100) : null;
  const volMcap = meta.volume24hUsd && meta.marketCapUsd && meta.marketCapUsd > 0 ? Math.round((meta.volume24hUsd/meta.marketCapUsd)*100) : null;
  const profileMeta = PROFILES[profile];

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
        <span style={{ padding: '3px 9px', borderRadius: 6, fontSize: 11, fontWeight: 700, background: `${profileMeta.color}18`, border: `1px solid ${profileMeta.color}40`, color: profileMeta.color }}>
          {profileMeta.icon} {profileMeta.label}
        </span>
        {report.kill?.triggered && <span className="chip chip-bad" style={{ fontSize: 11, fontWeight: 700 }}>🚨 KILL</span>}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button onClick={onReanalyze} disabled={busy} className="btn btn-ghost btn-sm" style={{ fontSize: 11, height: 30 }}>
            {busy ? '⏳' : '🔄 Re-analyze'}
          </button>
          {meta.url && <a href={meta.url} target="_blank" rel="noopener noreferrer" className="btn btn-ghost btn-sm" style={{ fontSize: 11, height: 30 }}>📊 Chart</a>}
          {meta.websites?.[0]?.url && <a href={meta.websites[0].url} target="_blank" rel="noopener noreferrer" className="btn btn-ghost btn-sm" style={{ fontSize: 11, height: 30 }}>🌐 Site</a>}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, marginBottom: 10, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 30, fontWeight: 900, letterSpacing: '-0.02em', fontFeatureSettings: '"tnum" 1' }}>{fmtPrice(meta.priceUsd)}</span>
        {h24 != null && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 17, fontWeight: 700, color: pctColor(h24) }}>{h24 >= 0 ? '▲' : '▼'} {fmtPct(h24)} 24h</span>}
        {h1 != null && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color: pctColor(h1) }}>{fmtPct(h1)} 1h</span>}
        {h6 != null && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color: pctColor(h6) }}>{fmtPct(h6)} 6h</span>}
      </div>

      <div style={{ display: 'flex', gap: '6px 20px', flexWrap: 'wrap' }}>
        {[
          { l: 'MCap', v: fmtUsd(meta.marketCapUsd) },
          { l: 'Liq', v: fmtUsd(meta.liquidityUsd), c: meta.liquidityUsd != null ? (meta.liquidityUsd > 100000 ? '#4ade80' : meta.liquidityUsd > 30000 ? '#f59e0b' : '#ef4444') : undefined },
          { l: 'Vol 24h', v: fmtUsd(meta.volume24hUsd) },
          ...(volMcap != null ? [{ l: 'Vol/MCap', v: `${volMcap}%`, c: volMcap > 20 ? '#4ade80' : undefined }] : []),
          ...(buyPct != null ? [{ l: 'Buys', v: `${buyPct}% (${buys}B/${sells}S)`, c: buyPct >= 55 ? '#4ade80' : buyPct <= 35 ? '#ef4444' : '#f59e0b' }] : []),
        ].map(({ l, v, c }) => (
          <div key={l} style={{ display: 'flex', gap: 5, alignItems: 'baseline' }}>
            <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-3)' }}>{l}</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 700, fontFeatureSettings: '"tnum" 1', color: (c as any) ?? 'var(--text)' }}>{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Overall verdict card ───────────────────────────────────────────────── */
function OverallVerdictCard({ report, profile }: { report: Report; profile: TradingProfile }) {
  const overall = computeOverall(report);
  const ai = report.aiReasoning;
  const color = vc(overall.verdict);
  const profileMeta = PROFILES[profile];
  const liq = report.meta.liquidityUsd;
  const safeOk = report.safety.honeypot !== 'yes' && !report.kill?.triggered && (report.safety.rugScore ?? 0) < 60;
  const pbs = report.playbooks.filter(pb => pb.verdict !== 'insufficient_data');
  const pbYes = pbs.filter(pb => pb.verdict === 'yes' || pb.verdict === 'strong_yes').length;
  const buys = report.meta.txns24h?.buys ?? 0, sells = report.meta.txns24h?.sells ?? 0, total = buys + sells;
  const buyPct = total > 0 ? Math.round((buys/total)*100) : null;

  const cats = ai ? [
    { label: 'Safety',       score: ai.categoryScores.safety,       max: 35 },
    { label: 'Distribution', score: ai.categoryScores.distribution, max: 30 },
    { label: 'Market',       score: ai.categoryScores.market,       max: 20 },
    { label: 'Social',       score: ai.categoryScores.social,       max: 10 },
    { label: 'Macro',        score: ai.categoryScores.macro,        max:  5 },
  ] : null;

  return (
    <div style={{
      background: `linear-gradient(135deg, ${color}09 0%, var(--surface) 60%)`,
      border: `1px solid ${color}35`,
      borderRadius: 14,
      boxShadow: `inset 0 1px 0 var(--highlight), 0 1px 3px rgba(0,0,0,0.3)`,
      overflow: 'hidden',
    }}>
      <div style={{ display: 'flex', gap: 24, padding: '20px 24px', alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <ScoreRing score={overall.score} size={108} strokeW={10} />
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 26, fontWeight: 900, lineHeight: 1, color, fontFeatureSettings: '"tnum" 1' }}>{overall.score}</span>
            <span style={{ fontSize: 9, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>/100</span>
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-3)', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 5 }}>
            {overall.source === 'ai' ? `🤖 ${profileMeta.label} Analysis` : '📊 Playbook Score'}
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 34, fontWeight: 900, color, lineHeight: 1, letterSpacing: '0.01em' }}>
            {vl(overall.verdict)}
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
            {safeOk ? <span style={{ fontSize: 11, fontWeight: 600, color: '#4ade80' }}>🛡️ Safety OK</span>
                     : <span style={{ fontSize: 11, fontWeight: 600, color: '#ef4444' }}>🚨 Safety Risk</span>}
            {buyPct != null && <span style={{ fontSize: 11, fontWeight: 600, color: buyPct >= 55 ? '#4ade80' : '#f59e0b' }}>💰 {buyPct}% Buys</span>}
            {liq != null && <span style={{ fontSize: 11, fontWeight: 600, color: liq > 100000 ? '#4ade80' : liq > 30000 ? '#f59e0b' : '#ef4444' }}>💧 {fmtUsd(liq)}</span>}
            {pbs.length > 0 && <span style={{ fontSize: 11, fontWeight: 600, color: pbYes >= 2 ? '#4ade80' : '#f59e0b' }}>🎯 {pbYes}/{pbs.length} Playbooks YES</span>}
          </div>
        </div>

        {cats && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 190 }}>
            {cats.map(cat => {
              const pct = (cat.score / cat.max) * 100;
              const barColor = pct >= 70 ? '#4ade80' : pct >= 40 ? '#f59e0b' : '#ef4444';
              return (
                <div key={cat.label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-3)', width: 76, flexShrink: 0 }}>{cat.label}</span>
                  <div style={{ flex: 1, height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2 }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: barColor, borderRadius: 2, transition: 'width 0.6s ease' }} />
                  </div>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: barColor, width: 38, textAlign: 'right', flexShrink: 0 }}>{cat.score}/{cat.max}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {report.kill?.triggered && (
        <div style={{ padding: '10px 24px', background: 'rgba(239,68,68,0.12)', borderTop: '1px solid rgba(239,68,68,0.25)', fontSize: 13, fontWeight: 600, color: '#ef4444' }}>
          🚨 Kill switch — {report.kill.reason}
        </div>
      )}

      {ai?.summary && (
        <div style={{ padding: '13px 24px', borderTop: '1px solid rgba(255,255,255,0.05)', background: 'rgba(168,85,247,0.04)' }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--accent-2)', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 7 }}>
            {profileMeta.icon} {profileMeta.label} Trader Take
          </div>
          <p style={{ fontSize: 14, fontWeight: 500, lineHeight: 1.75, color: 'var(--text)', margin: 0 }}>{ai.summary}</p>
        </div>
      )}

      {ai?.contradictions && ai.contradictions.length > 0 && (
        <div style={{ padding: '10px 24px', borderTop: '1px solid rgba(255,255,255,0.05)', background: 'rgba(245,158,11,0.04)' }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#f59e0b', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 6 }}>⚡ Signal Conflicts</div>
          {ai.contradictions.map((c, i) => (
            <div key={i} style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-2)', padding: '2px 0' }}>· {c}</div>
          ))}
        </div>
      )}

      {pbs.length > 0 && (
        <div style={{ padding: '10px 24px', borderTop: '1px solid rgba(255,255,255,0.05)', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {pbs.map(pb => (
            <span key={pb.key} style={{ fontSize: 11, fontWeight: 600, color: PB_COLOR[pb.verdict] ?? '#94a3b8', background: `${PB_COLOR[pb.verdict] ?? '#94a3b8'}15`, padding: '3px 9px', borderRadius: 20, border: `1px solid ${PB_COLOR[pb.verdict] ?? '#94a3b8'}28` }}>
              {pb.label} {pb.score != null ? pb.score.toFixed(1) : ''} — {PB_LABEL[pb.verdict]}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Trading strategy card ──────────────────────────────────────────────── */
function TradingStrategyCard({ strategy, profile }: { strategy: TradingStrategy; profile: TradingProfile }) {
  const profileMeta = PROFILES[profile];
  const confColor = strategy.confidence === 'HIGH' ? '#4ade80' : strategy.confidence === 'MEDIUM' ? '#f59e0b' : '#ef4444';

  return (
    <div style={{ background: 'var(--surface)', border: `1px solid ${profileMeta.color}30`, borderRadius: 12, boxShadow: 'inset 0 1px 0 var(--highlight)', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-3)', letterSpacing: '0.14em', textTransform: 'uppercase', flex: 1 }}>
          Trading Strategy
        </span>
        <span style={{ fontSize: 11, fontWeight: 700, color: profileMeta.color, background: `${profileMeta.color}18`, padding: '2px 8px', borderRadius: 5, border: `1px solid ${profileMeta.color}40` }}>
          {profileMeta.icon} {profileMeta.label}
        </span>
        <span style={{ fontSize: 11, fontWeight: 700, color: confColor, background: `${confColor}15`, padding: '2px 8px', borderRadius: 5, border: `1px solid ${confColor}35` }}>
          {strategy.confidence} CONFIDENCE
        </span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, color: 'var(--accent)' }}>R/R {strategy.riskReward}:1</span>
      </div>

      <div style={{ padding: '12px 16px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px' }}>
        {/* Entry zone */}
        <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 12, padding: '10px 12px', background: 'rgba(59,130,246,0.07)', borderRadius: 8, border: '1px solid rgba(59,130,246,0.18)' }}>
          <div style={{ flexShrink: 0 }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-3)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4 }}>Entry Zone</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 15, fontWeight: 800, color: 'var(--accent)', fontFeatureSettings: '"tnum" 1' }}>
              {strategy.entryZone ? `${fmtPrice(strategy.entryZone.low)} – ${fmtPrice(strategy.entryZone.high)}` : fmtPrice(strategy.entryPrice)}
            </div>
          </div>
          <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-3)', lineHeight: 1.55, paddingTop: 2 }}>{strategy.entryNote}</div>
        </div>

        {/* Stop loss */}
        <div style={{ padding: '10px 12px', background: 'rgba(239,68,68,0.06)', borderRadius: 8, border: '1px solid rgba(239,68,68,0.18)' }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-3)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4 }}>Stop Loss</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 15, fontWeight: 800, color: '#ef4444', fontFeatureSettings: '"tnum" 1' }}>
            {fmtPrice(strategy.stopLossPrice)} <span style={{ fontSize: 12, fontWeight: 600, color: '#ef444490' }}>−{strategy.stopLossPct}%</span>
          </div>
          <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-3)', marginTop: 4, lineHeight: 1.4 }}>{strategy.stopLossNote}</div>
        </div>

        {/* Position sizing */}
        <div style={{ padding: '10px 12px', background: 'rgba(168,85,247,0.06)', borderRadius: 8, border: '1px solid rgba(168,85,247,0.18)' }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-3)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4 }}>Position Size</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 800, color: 'var(--accent-2)', fontFeatureSettings: '"tnum" 1' }}>
            {strategy.positionSizing.pctRange[0]}–{strategy.positionSizing.pctRange[1]}%
          </div>
          {strategy.positionSizing.dollarRange && (
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, color: 'var(--accent-2)', opacity: 0.75 }}>
              ${strategy.positionSizing.dollarRange[0].toLocaleString()} – ${strategy.positionSizing.dollarRange[1].toLocaleString()}
            </div>
          )}
          <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-3)', marginTop: 4 }}>{strategy.positionSizing.portfolioNote}</div>
        </div>

        {/* Targets */}
        <div style={{ gridColumn: '1 / -1' }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-3)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 6 }}>Targets</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {strategy.targets.map((t, i) => {
              const tColors = ['#4ade80', '#22c55e', '#16a34a'];
              const c = tColors[i] ?? '#4ade80';
              return (
                <div key={t.label} style={{ flex: '1 1 0', minWidth: 140, padding: '9px 10px', background: `${c}08`, borderRadius: 8, border: `1px solid ${c}22` }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 3 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: c }}>{t.label} +{t.pct}%</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 800, color: c, fontFeatureSettings: '"tnum" 1' }}>{fmtPrice(t.price)}</span>
                  </div>
                  <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-3)', lineHeight: 1.4 }}>{t.action}</div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Trailing stop + max hold */}
        <div style={{ padding: '8px 12px', background: 'var(--surface-2)', borderRadius: 7 }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-3)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 3 }}>Trailing Stop</div>
          <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-2)' }}>{strategy.trailingStop}</div>
        </div>
        <div style={{ padding: '8px 12px', background: 'var(--surface-2)', borderRadius: 7 }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-3)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 3 }}>Max Hold</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{strategy.maxHoldTime}</div>
        </div>

        {/* Exit guidance */}
        {/* exit sizing is shown in AIBreakdownCard header */}

        {/* Warnings */}
        {strategy.warnings.length > 0 && (
          <div style={{ gridColumn: '1 / -1', padding: '9px 12px', background: 'rgba(245,158,11,0.07)', borderRadius: 8, border: '1px solid rgba(245,158,11,0.25)' }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#f59e0b', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 5 }}>⚠️ Warnings</div>
            {strategy.warnings.map((w, i) => (
              <div key={i} style={{ fontSize: 12, fontWeight: 500, color: '#fbbf24', padding: '2px 0' }}>· {w}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── AI breakdown ───────────────────────────────────────────────────────── */
function AIBreakdownCard({ report }: { report: Report }) {
  const ai = report.aiReasoning;
  if (!ai) return null;

  const cats = [
    { key: 'safety' as const,       label: '🛡️ Safety',       max: 35 },
    { key: 'distribution' as const, label: '👥 Distribution', max: 30 },
    { key: 'market' as const,       label: '📊 Market',       max: 20 },
    { key: 'social' as const,       label: '📱 Social',       max: 10 },
    { key: 'macro' as const,        label: '🌐 Macro',        max:  5 },
  ];

  return (
    <div className="section">
      <div className="section-header">
        <h3 className="section-title" style={{ fontSize: 14 }}>
          🤖 AI Score Breakdown
          <span style={{ fontSize: 11, color: 'var(--accent-2)', fontWeight: 500, marginLeft: 8 }}>
            Claude · {new Date(ai.generatedAt).toLocaleTimeString()}
          </span>
        </h3>
        {ai.exitSizing && (
          <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-3)', maxWidth: 320 }}>{ai.exitSizing}</span>
        )}
      </div>
      <div className="section-body" style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {cats.map(({ key, label, max }) => {
          const score = ai.categoryScores[key];
          const reason = ai.categoryReasons?.[key];
          const pct = (score / max) * 100;
          const barColor = pct >= 70 ? '#4ade80' : pct >= 40 ? '#f59e0b' : '#ef4444';
          return (
            <div key={key}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: reason ? 4 : 0 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', width: 116, flexShrink: 0 }}>{label}</span>
                <div style={{ flex: 1, height: 6, background: 'rgba(255,255,255,0.05)', borderRadius: 3 }}>
                  <div style={{ width: `${pct}%`, height: '100%', background: barColor, borderRadius: 3, transition: 'width 0.6s ease' }} />
                </div>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, color: barColor, width: 40, textAlign: 'right', flexShrink: 0 }}>{score}/{max}</span>
              </div>
              {reason && <div style={{ marginLeft: 126, fontSize: 11, fontWeight: 500, color: 'var(--text-3)', lineHeight: 1.55 }}>{reason}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─── Shared primitives ──────────────────────────────────────────────────── */
function Row({ label, value, color, mono = true, sub }: { label: string; value: string; color?: string; mono?: boolean; sub?: string }) {
  return (
    <div style={{ padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-3)', flexShrink: 0 }}>{label}</span>
        <span style={{ fontSize: 13, fontWeight: 600, fontFamily: mono ? 'var(--font-mono)' : 'inherit', fontFeatureSettings: '"tnum" 1', color: color ?? 'var(--text)', textAlign: 'right', maxWidth: '60%' }}>{value}</span>
      </div>
      {sub && <div style={{ fontSize: 10, fontWeight: 500, color: 'var(--text-3)', textAlign: 'right', marginTop: 1 }}>{sub}</div>}
    </div>
  );
}
function Badge({ text, color }: { text: string; color: string }) {
  return <span style={{ fontSize: 10, fontWeight: 600, color, background: `${color}15`, padding: '1px 6px', borderRadius: 4, border: `1px solid ${color}30`, flexShrink: 0 }}>{text}</span>;
}
function SectionCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="section">
      <div className="section-header"><h3 className="section-title" style={{ fontSize: 13 }}>{title}</h3></div>
      <div className="section-body" style={{ padding: '8px 14px' }}>{children}</div>
    </div>
  );
}

/* ─── Safety ─────────────────────────────────────────────────────────────── */
function SafetyCard({ report }: { report: Report }) {
  const { safety, aiReasoning } = report;
  const checks = [safety.honeypot==='no', safety.mintAuthority===false, safety.freezeAuthority===false, safety.lpLocked==='yes', (safety.rugScore??100)<40];
  const pass = checks.filter(Boolean).length;
  const barColor = pass>=4 ? '#4ade80' : pass>=2 ? '#f59e0b' : '#ef4444';
  const status = pass>=4 ? 'CLEAN' : pass>=2 ? 'CAUTION' : 'RISKY';
  return (
    <SectionCard title={`🛡️ Safety — ${status}`}>
      {aiReasoning?.categoryReasons?.safety && (
        <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-3)', lineHeight: 1.6, marginBottom: 8, padding: '7px 9px', background: 'rgba(168,85,247,0.07)', borderRadius: 6, borderLeft: '2px solid var(--accent-2)' }}>
          {aiReasoning.categoryReasons.safety}
        </div>
      )}
      <Row label="Honeypot" value={safety.honeypot==='no'?'Not a honeypot':safety.honeypot==='yes'?'HONEYPOT!':'Unknown'} color={safety.honeypot==='no'?'#4ade80':safety.honeypot==='yes'?'#ef4444':'#f59e0b'} mono={false} />
      <Row label="Mint authority" value={safety.mintAuthority==null?'Unknown':safety.mintAuthority?'ACTIVE':'Revoked'} color={safety.mintAuthority==null?'#94a3b8':safety.mintAuthority?'#ef4444':'#4ade80'} mono={false} />
      <Row label="Freeze authority" value={safety.freezeAuthority==null?'Unknown':safety.freezeAuthority?'ACTIVE':'Revoked'} color={safety.freezeAuthority==null?'#94a3b8':safety.freezeAuthority?'#ef4444':'#4ade80'} mono={false} />
      <Row label="LP locked" value={safety.lpLocked==='yes'?'Locked':safety.lpLocked==='no'?'Unlocked':'Unknown'} color={safety.lpLocked==='yes'?'#4ade80':safety.lpLocked==='no'?'#ef4444':'#f59e0b'} mono={false} />
      <Row label="Buy / Sell tax" value={`${fmtTax(safety.buyTax)} / ${fmtTax(safety.sellTax)}`} color={(safety.buyTax??0)>500||(safety.sellTax??0)>500?'#ef4444':'#4ade80'} />
      <Row label="Rug score" value={safety.rugScore!=null?`${safety.rugScore}/100`:'—'} color={(safety.rugScore??0)>60?'#ef4444':(safety.rugScore??0)>30?'#f59e0b':'#4ade80'} />
      {safety.holdersCount!=null && <Row label="Holders" value={safety.holdersCount.toLocaleString()} />}
      {safety.flags.length > 0 && (
        <div style={{ marginTop: 8, padding: '7px 9px', background: 'rgba(239,68,68,0.07)', borderRadius: 6 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#ef4444', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4 }}>🚩 {safety.flags.length} Flag{safety.flags.length>1?'s':''}</div>
          {safety.flags.map((f,i) => <div key={i} style={{ fontSize: 11, fontWeight: 500, color: '#f87171', padding: '2px 0' }}>· {f}</div>)}
        </div>
      )}
      <div style={{ marginTop: 8, padding: '6px 10px', background: `${barColor}12`, borderRadius: 6, fontSize: 11, fontWeight: 700, color: barColor, textAlign: 'center', border: `1px solid ${barColor}25` }}>
        {pass>=4?'✅ Passes all critical checks':pass>=2?'⚠️ Some concerns':'🚨 Multiple red flags'}
      </div>
    </SectionCard>
  );
}

/* ─── Market ─────────────────────────────────────────────────────────────── */
function MarketCard({ report }: { report: Report }) {
  const { meta, aiReasoning, holderMetrics } = report;
  const buys = meta.txns24h?.buys??0, sells = meta.txns24h?.sells??0, total = buys+sells;
  const buyPct = total > 0 ? Math.round((buys/total)*100) : null;
  const volMcap = meta.volume24hUsd&&meta.marketCapUsd&&meta.marketCapUsd>0 ? Math.round((meta.volume24hUsd/meta.marketCapUsd)*100) : null;
  const lifecycle = holderMetrics?.lifecycle;
  const impact = holderMetrics?.priceImpact;

  return (
    <SectionCard title={`📈 Market${lifecycle ? ` — ${lifecycle.stage.toUpperCase()}` : ''}`}>
      {aiReasoning?.categoryReasons?.market && (
        <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-3)', lineHeight: 1.6, marginBottom: 8, padding: '7px 9px', background: 'rgba(168,85,247,0.07)', borderRadius: 6, borderLeft: '2px solid var(--accent-2)' }}>
          {aiReasoning.categoryReasons.market}
        </div>
      )}
      <Row label="Price" value={fmtPrice(meta.priceUsd)} />
      <Row label="5m / 1h / 24h" value={`${fmtPct(meta.priceChange.m5)} / ${fmtPct(meta.priceChange.h1)} / ${fmtPct(meta.priceChange.h24)}`} color={pctColor(meta.priceChange.h24)} />
      <Row label="MCap / FDV" value={`${fmtUsd(meta.marketCapUsd)} / ${fmtUsd(meta.fdvUsd)}`} />
      <Row label="Liquidity" value={fmtUsd(meta.liquidityUsd)} color={meta.liquidityUsd!=null?(meta.liquidityUsd>100000?'#4ade80':meta.liquidityUsd>30000?'#f59e0b':'#ef4444'):undefined} />
      <Row label="Vol 24h" value={fmtUsd(meta.volume24hUsd)} />
      {volMcap!=null && <Row label="Vol/MCap" value={`${volMcap}%`} color={volMcap>20?'#4ade80':'var(--text)'} />}
      {buyPct!=null && <Row label="Buy pressure" value={`${buyPct}% (${buys}B/${sells}S)`} color={buyPct>=60?'#4ade80':buyPct>=45?'#f59e0b':'#ef4444'} mono={false} />}
      {holderMetrics?.organicScore!=null && <Row label="Organic score" value={`${holderMetrics.organicScore}/100`} color={holderMetrics.organicScore>60?'#4ade80':holderMetrics.organicScore>30?'#f59e0b':'#ef4444'} sub="Jupiter organic activity" />}
      {lifecycle && (
        <>
          <Row label="Launch platform" value={lifecycle.launchPlatform ?? 'Unknown'} mono={false} />
          {lifecycle.bondingCurvePct!=null && <Row label="Bonding curve" value={`${lifecycle.bondingCurvePct.toFixed(1)}%`} color={lifecycle.bondingCurvePct>60?'#4ade80':lifecycle.bondingCurvePct>30?'#f59e0b':'#ef4444'} />}
          {lifecycle.kingOfTheHill && <Row label="King of the Hill" value="YES 👑" color="#f59e0b" />}
        </>
      )}
      {impact && (
        <div style={{ marginTop: 6, padding: '7px 9px', background: 'rgba(59,130,246,0.06)', borderRadius: 6, border: '1px solid rgba(59,130,246,0.15)' }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-3)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4 }}>Price Impact</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '2px 8px', fontSize: 11, fontFamily: 'var(--font-mono)' }}>
            {[['$500', impact.buy500Usd], ['$1K', impact.buy1000Usd], ['$5K', impact.buy5000Usd]].map(([size, val]) => val != null ? (
              <div key={size as string} style={{ color: (val as number) > 10 ? '#ef4444' : (val as number) > 5 ? '#f59e0b' : '#4ade80' }}>
                {size}: {(val as number).toFixed(1)}%
              </div>
            ) : null)}
          </div>
        </div>
      )}
      <Row label="Pair age" value={fmtAge(meta.pairAgeHours)} />
    </SectionCard>
  );
}

/* ─── Holders ────────────────────────────────────────────────────────────── */
function HoldersCard({ report }: { report: Report }) {
  const { safety, holderMetrics, aiReasoning } = report;
  const total = holderMetrics?.totalHolders ?? safety.holdersCount;
  const top10 = holderMetrics?.top10ConcentrationPct ?? safety.topHoldersPct;
  const top100 = holderMetrics?.top100ConcentrationPct;
  const bundle = holderMetrics?.bundleInfo;
  const chainCtx = holderMetrics?.chainContext;
  const bundleBad = bundle?.detected && (bundle.bundledSupplyPct ?? 0) > 10;
  const status = bundleBad ? 'BUNDLE DETECTED' : top10!=null&&top10>60 ? 'WHALE HEAVY' : top10!=null&&top10>35 ? 'MODERATE' : 'HEALTHY';

  return (
    <SectionCard title={`👥 Distribution — ${status}`}>
      {aiReasoning?.categoryReasons?.distribution && (
        <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-3)', lineHeight: 1.6, marginBottom: 8, padding: '7px 9px', background: 'rgba(168,85,247,0.07)', borderRadius: 6, borderLeft: '2px solid var(--accent-2)' }}>
          {aiReasoning.categoryReasons.distribution}
        </div>
      )}
      <Row label="Total holders" value={total!=null?total.toLocaleString():'—'} color={total!=null&&total>1000?'#4ade80':'var(--text)'} />
      <Row label="Top 10 concentration" value={top10!=null?`${top10.toFixed(1)}%`:'—'} color={top10!=null?(top10>60?'#ef4444':top10>35?'#f59e0b':'#4ade80'):'#94a3b8'} />
      {top100!=null && <Row label="Top 100 concentration" value={`${top100.toFixed(1)}%`} color={top100>80?'#ef4444':top100>60?'#f59e0b':'#4ade80'} />}
      {bundle && (
        <div style={{ marginTop: 6, padding: '8px 10px', background: bundle.detected ? 'rgba(239,68,68,0.08)' : 'rgba(34,197,94,0.06)', borderRadius: 7, border: `1px solid ${bundle.detected ? 'rgba(239,68,68,0.25)' : 'rgba(34,197,94,0.2)'}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: bundle.detected ? 4 : 0 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: bundle.detected ? '#ef4444' : '#4ade80' }}>
              {bundle.detected ? '🔴 Bundle detected' : '🟢 No bundle detected'}
            </span>
            {bundle.source && <Badge text={bundle.source} color={bundle.detected ? '#ef4444' : '#4ade80'} />}
          </div>
          {bundle.detected && bundle.bundledSupplyPct != null && (
            <div style={{ fontSize: 11, fontWeight: 600, color: '#f87171' }}>
              {bundle.bundleCount ?? '?'} bundle group(s) · {bundle.bundledSupplyPct.toFixed(1)}% of supply
            </div>
          )}
          {bundle.bundledWallets && bundle.bundledWallets.length > 0 && (
            <div style={{ marginTop: 4, fontSize: 10, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
              {bundle.bundledWallets.slice(0, 3).map((w, i) => <div key={i}>· {w.slice(0, 16)}…</div>)}
            </div>
          )}
        </div>
      )}
      {chainCtx && (
        <div style={{ marginTop: 6 }}>
          <Row label="Chain TVL" value={fmtUsd(chainCtx.tvlUsd)} sub="DeFiLlama" />
          {chainCtx.tvl7dChangePct!=null && <Row label="TVL 7d" value={fmtPct(chainCtx.tvl7dChangePct)} color={pctColor(chainCtx.tvl7dChangePct)} />}
        </div>
      )}
      {aiReasoning?.categoryReasons?.macro && (
        <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-3)', lineHeight: 1.5, marginTop: 8, padding: '6px 9px', background: 'rgba(168,85,247,0.05)', borderRadius: 5, borderLeft: '2px solid rgba(168,85,247,0.3)' }}>
          🌐 {aiReasoning.categoryReasons.macro}
        </div>
      )}
    </SectionCard>
  );
}

/* ─── Social ─────────────────────────────────────────────────────────────── */
function SocialCard({ report }: { report: Report }) {
  const { socialData, aiReasoning } = report;
  const status = !socialData ? 'NO DATA' : socialData.hasSocials ? 'PRESENT' : 'ABSENT';
  return (
    <SectionCard title={`📱 Social — ${status}`}>
      {aiReasoning?.categoryReasons?.social && (
        <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-3)', lineHeight: 1.6, marginBottom: 8, padding: '7px 9px', background: 'rgba(168,85,247,0.07)', borderRadius: 6, borderLeft: '2px solid var(--accent-2)' }}>
          {aiReasoning.categoryReasons.social}
        </div>
      )}
      <Row label="Twitter" value={socialData?.twitterUrl?'Present':'Not found'} color={socialData?.twitterUrl?'#4ade80':'#94a3b8'} mono={false} />
      <Row label="Telegram" value={socialData?.telegramUrl?'Present':'Not found'} color={socialData?.telegramUrl?'#4ade80':'#94a3b8'} mono={false} />
      {socialData?.telegramMembers!=null && <Row label="Members" value={socialData.telegramMembers.toLocaleString()} color={socialData.telegramMembers>5000?'#4ade80':socialData.telegramMembers>1000?'#f59e0b':'#ef4444'} />}
      {socialData?.telegramActiveRate!=null && <Row label="TG msg/hr" value={socialData.telegramActiveRate.toFixed(1)} />}
      <Row label="Website" value={socialData?.websiteUrl?'Present':'Not found'} color={socialData?.websiteUrl?'#4ade80':'#94a3b8'} mono={false} />
      {socialData?.domainAgeDays!=null && <Row label="Domain age" value={`${socialData.domainAgeDays}d`} color={socialData.domainAgeDays>90?'#4ade80':socialData.domainAgeDays>14?'#f59e0b':'#ef4444'} />}
      {socialData?.websiteChanged && (
        <div style={{ marginTop: 6, fontSize: 11, fontWeight: 600, color: '#f59e0b', padding: '4px 8px', background: 'rgba(245,158,11,0.08)', borderRadius: 5 }}>
          ⚠️ Website recently changed (Wayback Machine)
        </div>
      )}
      {socialData?.twitterMentions24h!=null && <Row label="Twitter mentions 24h" value={socialData.twitterMentions24h.toLocaleString()} color={socialData.twitterMentions24h>100?'#4ade80':'var(--text)'} />}
    </SectionCard>
  );
}

/* ─── Smart money ────────────────────────────────────────────────────────── */
function SmartMoneyCard({ report }: { report: Report }) {
  const { smartMoney } = report;
  const hasData = smartMoney != null && smartMoney.walletsChecked > 0;
  const bullish = hasData && smartMoney!.holdersFound > 0;
  const status = !hasData ? 'NOT CHECKED' : bullish ? `${smartMoney!.holdersFound} FOUND` : 'NONE';
  const signals = smartMoney?.signals ?? [];

  return (
    <SectionCard title={`🧠 Smart Money — ${status}`}>
      {!hasData ? (
        <div style={{ padding: '12px 0', color: 'var(--text-3)', fontSize: 12 }}>
          No smart money data. Set HELIUS_RPC_URL for Solana wallet scanning.
        </div>
      ) : (
        <>
          <Row label="Wallets checked" value={String(smartMoney!.walletsChecked)} />
          <Row label="Smart holders" value={`${smartMoney!.holdersFound}`} color={smartMoney!.holdersFound > 0 ? '#4ade80' : 'var(--text-2)'} />
          {signals.length > 0 ? (
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {signals.slice(0, 5).map((sig, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', background: 'rgba(34,197,94,0.06)', borderRadius: 6, border: '1px solid rgba(34,197,94,0.15)' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-3)' }}>{sig.walletAddress.slice(0, 10)}…</span>
                  {sig.label && <span style={{ fontSize: 11, fontWeight: 600, color: '#4ade80' }}>{sig.label}</span>}
                  {sig.winRate != null && <span style={{ fontSize: 11, fontWeight: 700, color: '#22c55e', marginLeft: 'auto' }}>{sig.winRate}% win</span>}
                  {sig.action && <span style={{ fontSize: 10, color: 'var(--text-3)', fontWeight: 600, textTransform: 'uppercase' }}>{sig.action}</span>}
                  {sig.source && <Badge text={sig.source} color="#4ade80" />}
                </div>
              ))}
            </div>
          ) : smartMoney!.holders.length > 0 ? (
            <div style={{ marginTop: 8 }}>
              {smartMoney!.holders.map((h, i) => (
                <div key={i} style={{ fontSize: 12, fontWeight: 600, color: '#4ade80', padding: '3px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  · {h.label}{h.winRate ? ` — ${h.winRate}% win` : ''}
                </div>
              ))}
            </div>
          ) : (
            <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-3)', fontStyle: 'italic' }}>No smart wallets holding this token.</div>
          )}
        </>
      )}
    </SectionCard>
  );
}

/* ─── Signals row ────────────────────────────────────────────────────────── */
function SignalsRow({ report }: { report: Report }) {
  const ai = report.aiReasoning;
  if (!ai) return null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
      <div className="section">
        <div className="section-header"><h3 className="section-title" style={{ fontSize: 13, color: '#4ade80' }}>✅ Bullish Signals</h3></div>
        <div className="section-body" style={{ padding: '6px 14px' }}>
          {ai.bullishSignals.length === 0
            ? <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '4px 0' }}>None identified</div>
            : ai.bullishSignals.map((s, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', fontSize: 12, fontWeight: 500 }}>
                <span style={{ color: '#4ade80', flexShrink: 0 }}>↑</span>
                <span style={{ color: 'var(--text)', lineHeight: 1.45 }}>{s}</span>
              </div>
            ))}
        </div>
      </div>
      <div className="section">
        <div className="section-header"><h3 className="section-title" style={{ fontSize: 13, color: '#ef4444' }}>⚠️ Risk Factors</h3></div>
        <div className="section-body" style={{ padding: '6px 14px' }}>
          {ai.riskFactors.length === 0
            ? <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '4px 0' }}>None identified</div>
            : ai.riskFactors.map((s, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', fontSize: 12, fontWeight: 500 }}>
                <span style={{ color: '#ef4444', flexShrink: 0 }}>↓</span>
                <span style={{ color: 'var(--text)', lineHeight: 1.45 }}>{s}</span>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

/* ─── Playbooks grid ─────────────────────────────────────────────────────── */
function PlaybooksGrid({ report }: { report: Report }) {
  const pbs = report.playbooks;
  if (!pbs.length) return null;
  return (
    <div className="section">
      <div className="section-header"><h3 className="section-title" style={{ fontSize: 13 }}>🎯 Playbook Verdicts</h3></div>
      <div className="section-body" style={{ padding: '10px 14px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
          {pbs.map(pb => {
            const color = PB_COLOR[pb.verdict] ?? '#94a3b8';
            return (
              <div key={pb.key} style={{ padding: '11px 12px', background: 'var(--surface-2)', borderRadius: 9, border: `1px solid ${color}28` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 5 }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', marginBottom: 1 }}>{pb.label}</div>
                    <div style={{ fontSize: 10, fontWeight: 500, color: 'var(--text-3)' }}>{pb.description}</div>
                  </div>
                  {pb.score != null && (
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 18, fontWeight: 900, color, lineHeight: 1, flexShrink: 0 }}>
                      {pb.score.toFixed(1)}<span style={{ fontSize: 10, color: 'var(--text-3)' }}>/10</span>
                    </div>
                  )}
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 800, color, marginBottom: 6 }}>{PB_LABEL[pb.verdict]}</div>
                {pb.signals.filter(s=>s.weight!=='info').slice(0,3).map((sig, i) => (
                  <div key={i} style={{ display: 'flex', gap: 5, fontSize: 11, fontWeight: 500, color: 'var(--text-3)', padding: '1px 0' }}>
                    <span style={{ color: sig.weight==='positive'?'#4ade80':sig.weight==='negative'?'#ef4444':'#f59e0b', flexShrink: 0 }}>
                      {sig.weight==='positive'?'↑':sig.weight==='negative'?'↓':'·'}
                    </span>
                    {sig.label}
                  </div>
                ))}
                {pb.plan && (
                  <div style={{ marginTop: 8, padding: '7px 8px', background: 'rgba(59,130,246,0.07)', borderRadius: 6, border: '1px solid rgba(59,130,246,0.18)', fontSize: 11 }}>
                    <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--accent)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4 }}>Trade Plan</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '40px 1fr', gap: '3px 6px' }}>
                      <span style={{ color: 'var(--text-3)' }}>Entry</span><span style={{ color: 'var(--text)', fontWeight: 600 }}>{pb.plan.entry}</span>
                      <span style={{ color: 'var(--text-3)' }}>Stop</span><span style={{ color: '#ef4444', fontWeight: 700 }}>{pb.plan.stop}</span>
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

/* ─── Comparable tokens ──────────────────────────────────────────────────── */
function ComparableTokensCard({ tokens }: { tokens: ComparableToken[] }) {
  if (!tokens.length) return null;
  return (
    <div className="section">
      <div className="section-header">
        <h3 className="section-title" style={{ fontSize: 13 }}>🔭 Comparable Tokens</h3>
        <span className="chip" style={{ fontSize: 10 }}>Similar age · market cap</span>
      </div>
      <div className="section-body" style={{ padding: 0 }}>
        <div style={{ overflowX: 'auto' }}>
          <table className="table" style={{ width: '100%', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['Token', 'MCap', 'Age at scan', 'AI Score', 'Verdict'].map(h => (
                  <th key={h} style={{ padding: '7px 14px', fontSize: 10, fontWeight: 600, color: 'var(--text-3)', letterSpacing: '0.1em', textTransform: 'uppercase', textAlign: h==='MCap'||h==='AI Score'?'right':'left' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tokens.map((t, i) => (
                <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px 14px' }}>
                    <div style={{ fontWeight: 700, color: 'var(--text)' }}>{t.symbol ?? t.address.slice(0, 8)}</div>
                    {t.url ? (
                      <a href={t.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 10, color: 'var(--accent)', textDecoration: 'none' }}>Chart ↗</a>
                    ) : (
                      <span style={{ fontSize: 10, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>{t.address.slice(0, 10)}…</span>
                    )}
                  </td>
                  <td style={{ padding: '8px 14px', textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--text-2)' }}>{fmtUsd(t.marketCapUsd)}</td>
                  <td style={{ padding: '8px 14px', fontFamily: 'var(--font-mono)', color: 'var(--text-3)' }}>{fmtAge(t.ageHoursAtScan)}</td>
                  <td style={{ padding: '8px 14px', textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 700, color: t.aiScore != null ? vc(t.aiScore >= 80 ? 'STRONG_BUY' : t.aiScore >= 65 ? 'BUY' : t.aiScore >= 50 ? 'CAUTIOUS' : 'SKIP') : 'var(--text-3)' }}>
                    {t.aiScore ?? '—'}
                  </td>
                  <td style={{ padding: '8px 14px' }}>
                    {t.aiVerdict ? (
                      <span style={{ fontSize: 10, fontWeight: 700, color: vc(t.aiVerdict), background: `${vc(t.aiVerdict)}15`, padding: '2px 7px', borderRadius: 4 }}>
                        {vl(t.aiVerdict)}
                      </span>
                    ) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ─── Data pipeline ──────────────────────────────────────────────────────── */
function Pipeline({ report }: { report: Report }) {
  const [open, setOpen] = useState(false);
  const hits = report.providers.filter(p => p.status === 'hit').length;
  return (
    <div className="section">
      <button onClick={() => setOpen(o=>!o)} style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, padding: '0 14px', height: 44, borderBottom: open?'1px solid var(--border)':'none' }}>
        <h3 style={{ margin: 0, flex: 1, fontSize: 13, fontWeight: 700, color: 'var(--text)', textAlign: 'left' }}>⚙️ Data Pipeline</h3>
        <span className="chip" style={{ fontSize: 10 }}>{hits}/{report.providers.length} providers hit</span>
        <span style={{ fontSize: 10, color: 'var(--text-3)' }}>{open?'▲':'▼'}</span>
      </button>
      {open && (
        <div style={{ padding: '8px 14px' }}>
          {report.providers.map((p, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', fontSize: 12 }}>
              <span className={`chip chip-${p.status==='hit'?'ok':p.status==='error'?'bad':'warn'}`} style={{ fontSize: 9, width: 40, justifyContent: 'center', fontWeight: 700 }}>{p.status}</span>
              <span style={{ color: 'var(--text-2)', flex: 1 }}>{p.name}</span>
              {p.note && <span style={{ color: 'var(--text-3)', fontSize: 11 }}>{p.note}</span>}
            </div>
          ))}
          <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text-3)', lineHeight: 1.5 }}>{report.disclaimer}</div>
        </div>
      )}
    </div>
  );
}

/* ─── Full report view ───────────────────────────────────────────────────── */
function ReportView({ report, onReanalyze, busy, profile, depth }: {
  report: Report; onReanalyze: () => void; busy: boolean; profile: TradingProfile; depth: ReportDepth;
}) {
  const strategy = report.tradingStrategy;
  const isQuick = depth === 'quick' || !report.aiReasoning;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} className="fade-in">
      <TokenHeader report={report} onReanalyze={onReanalyze} busy={busy} profile={profile} />
      <OverallVerdictCard report={report} profile={profile} />
      {strategy && <TradingStrategyCard strategy={strategy} profile={profile} />}
      {!isQuick && <AIBreakdownCard report={report} />}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <SafetyCard report={report} />
        <MarketCard report={report} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <HoldersCard report={report} />
        <SocialCard report={report} />
      </div>
      <SmartMoneyCard report={report} />
      {!isQuick && <SignalsRow report={report} />}
      <PlaybooksGrid report={report} />
      {report.comparableTokens && <ComparableTokensCard tokens={report.comparableTokens} />}
      <Pipeline report={report} />
      <div style={{ textAlign: 'right', fontSize: 10, fontWeight: 500, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
        {new Date(report.generatedAt).toLocaleString()} · ttl {report.cacheTtlSec}s
      </div>
    </div>
  );
}

/* ─── Main page ──────────────────────────────────────────────────────────── */
function IntelPageClient() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [input, setInput] = useState(searchParams.get('address') ?? '');
  const [profile, setProfile] = useState<TradingProfile>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(PROFILE_KEY);
      if (saved && saved in PROFILES) return saved as TradingProfile;
    }
    const fromParam = searchParams.get('profile');
    if (fromParam && fromParam in PROFILES) return fromParam as TradingProfile;
    return 'meme_hunter';
  });
  const [depth, setDepth] = useState<ReportDepth>(() => {
    const d = searchParams.get('depth');
    return (d === 'quick' || d === 'dossier') ? d : 'alpha';
  });
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [histKey, setHistKey] = useState(0);

  const handleProfileChange = (p: TradingProfile) => {
    setProfile(p);
    try { localStorage.setItem(PROFILE_KEY, p); } catch {}
    if (report) {
      // Re-analyze with new profile
      triggerAnalyze(report.meta.address, p, depth, false);
    }
  };

  const triggerAnalyze = useCallback(async (
    addr: string, p: TradingProfile, d: ReportDepth, force: boolean,
  ) => {
    const trimmed = addr.trim();
    if (!trimmed) return;
    if (force) setBusy(true); else setLoading(true);
    setError(null);
    if (!force) setReport(null);
    try {
      let url: string;
      if (d === 'quick') {
        url = `/intel/${encodeURIComponent(trimmed)}?depth=quick${force ? '&force=true' : ''}`;
      } else {
        url = `/intel/${encodeURIComponent(trimmed)}?depth=${d}&profile=${p}${force ? '&force=true' : ''}`;
      }
      const { data } = await api.get<Report>(url);
      setReport(data);
      saveHistory(data);
      setHistKey(k => k+1);
      router.replace(`/intel?address=${encodeURIComponent(trimmed)}&profile=${p}&depth=${d}`, { scroll: false });
    } catch (e: any) {
      const msg = e?.response?.data?.message ?? e?.message ?? 'Analysis failed.';
      setError(typeof msg === 'string' ? msg : JSON.stringify(msg));
    } finally {
      setLoading(false);
      setBusy(false);
    }
  }, [router]);

  const analyze = useCallback((addr: string, force = false) => {
    triggerAnalyze(addr, profile, depth, force);
  }, [triggerAnalyze, profile, depth]);

  useEffect(() => {
    const addr = searchParams.get('address');
    if (addr) { setInput(addr); triggerAnalyze(addr, profile, depth, false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadingMsg = depth === 'quick'
    ? '⚡ Running fast scan…'
    : depth === 'dossier'
    ? `📋 ${PROFILES[profile].icon} Full Dossier pipeline…`
    : `🤖 ${PROFILES[profile].icon} ${PROFILES[profile].label} analysis…`;

  const loadingSteps = depth === 'quick'
    ? 'DexScreener → Safety → Playbooks'
    : 'DexScreener → Safety → Holders → Social → Smart Money → Claude AI';

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0, overflow: 'hidden' }}>
      <HistorySidebar key={histKey} onAnalyze={(addr, force) => { setInput(addr); analyze(addr, force); }} currentAddr={report?.meta.address} />

      <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '18px 20px 32px' }}>
        {/* Header */}
        <header style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-3)', letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 2 }}>Token Intelligence</div>
          <h1 style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-0.02em', margin: 0 }}>Intelligence Dashboard</h1>
        </header>

        {/* Controls */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <ProfileSelector profile={profile} onChange={handleProfileChange} />
          <div style={{ marginLeft: 'auto' }}>
            <DepthToggle depth={depth} onChange={(d) => { setDepth(d); if (report) triggerAnalyze(report.meta.address, profile, d, false); }} />
          </div>
        </div>

        {/* Tagline for selected profile */}
        <div style={{ fontSize: 11, fontWeight: 500, color: PROFILES[profile].color, marginBottom: 12, opacity: 0.8 }}>
          {PROFILES[profile].tagline}
        </div>

        {/* Search */}
        <form onSubmit={e => { e.preventDefault(); triggerAnalyze(input, profile, depth, false); }} style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          <input
            className="input"
            placeholder="Paste token address — Solana or 0x… EVM"
            value={input}
            onChange={e => setInput(e.target.value)}
            style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 12 }}
          />
          <button type="submit" disabled={loading} className="btn btn-primary btn-sm" style={{ flexShrink: 0, minWidth: 90, height: 32, fontSize: 12, fontWeight: 700 }}>
            {loading ? '⏳' : '🔍 Analyze'}
          </button>
        </form>

        {loading && (
          <div className="section" style={{ padding: '36px 24px', textAlign: 'center' }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-2)', marginBottom: 8 }}>{loadingMsg}</div>
            <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>{loadingSteps}</div>
          </div>
        )}

        {error && !loading && (
          <div style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.22)', borderRadius: 10, padding: '12px 16px' }}>
            <div style={{ color: '#ef4444', fontSize: 14, fontWeight: 700, marginBottom: 3 }}>🚨 Analysis failed</div>
            <div style={{ color: 'var(--text-2)', fontSize: 12, fontWeight: 500 }}>{error}</div>
          </div>
        )}

        {report && !loading && (
          <ReportView
            report={report}
            onReanalyze={() => analyze(report.meta.address, true)}
            busy={busy}
            profile={profile}
            depth={depth}
          />
        )}

        {!report && !loading && !error && (
          <div className="section" style={{ padding: '56px 24px', textAlign: 'center' }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>🔍</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-2)', marginBottom: 5 }}>Paste a token address above</div>
            <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-3)', marginBottom: 16 }}>
              Solana · Ethereum · BSC · Base · Arbitrum · Optimism and more
            </div>
            <div style={{ display: 'inline-grid', gridTemplateColumns: '1fr 1fr', gap: '5px 24px', fontSize: 11, fontWeight: 500, color: 'var(--text-3)', textAlign: 'left' }}>
              <span>🤖 5 trading profiles with AI personas</span><span>🛡️ Safety · Bundle · Honeypot checks</span>
              <span>📈 Trading strategy: entry, stop, targets</span><span>⚡ Quick mode &lt;2s without AI</span>
              <span>🧠 Smart money + GMGN wallet signals</span><span>📋 Dossier mode with comparable tokens</span>
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
