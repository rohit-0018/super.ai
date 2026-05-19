'use client';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../../../lib/api';
import { Section } from '../../../components/ui/Section';
import { Stat } from '../../../components/ui/Stat';
import { TokenSearchInput } from '../../../components/TokenSearchInput';
import type { ResolvedToken } from '../../../lib/useTokenResolve';

/* ── Types ──────────────────────────────────────────────────────────────────── */

type Chain = 'SOLANA' | 'EVM';
type Verdict = 'strong_yes' | 'yes' | 'neutral' | 'no' | 'strong_no' | 'insufficient_data';
type AiVerdict = 'STRONG_BUY' | 'BUY' | 'CAUTIOUS' | 'SKIP' | 'HIGH_RISK';

interface ProviderStatus { name: string; status: 'hit' | 'miss' | 'error' | 'skipped'; note?: string; }
type PlaybookKey = 'early_safe' | 'smart_money' | 'narrative' | 'momentum';
interface Signal { label: string; weight: 'critical' | 'positive' | 'negative' | 'info'; detail?: string; delta?: number; }
interface Breakdown { baseline: number; appliedDeltas: { label: string; delta: number; weight: Signal['weight'] }[]; raw: number; clamped: number; evidenceTotal: number; evidenceThreshold: number; }
interface Plan { sizeHint: string; entry: string; stop: string; targets: string[]; notes?: string; }
interface Playbook { key: PlaybookKey; label: string; description: string; score: number | null; verdict: Verdict; signals: Signal[]; breakdown: Breakdown; plan?: Plan; }

interface KillResult { triggered: boolean; checkId?: string; reason?: string; }
interface HolderMetrics { totalHolders?: number; top10ConcentrationPct?: number; deployerHoldsPct?: number; bundleDetected?: boolean; }
interface SocialData { twitterUrl?: string; telegramUrl?: string; websiteUrl?: string; telegramMembers?: number; domainAgeDays?: number; hasSocials: boolean; }
interface SmartMoneyResult { walletsChecked: number; holdersFound: number; holders: Array<{ label: string }>; }

interface AiReasoning {
  score: number;
  verdict: AiVerdict;
  categoryScores: { safety: number; market: number; holders: number; social: number; momentum: number; };
  categoryReasons?: { safety?: string; market?: string; holders?: string; social?: string; momentum?: string; };
  bullishSignals: string[];
  riskFactors: string[];
  summary: string;
  generatedAt: string;
}

interface Report {
  meta: {
    chain: Chain; address: string; symbol?: string; name?: string;
    priceUsd?: number; marketCapUsd?: number; fdvUsd?: number; liquidityUsd?: number;
    volume24hUsd?: number; priceChange: { m5?: number; h1?: number; h6?: number; h24?: number; };
    txns24h?: { buys?: number; sells?: number };
    pairCreatedAt?: string; pairAgeHours?: number; dex?: string; url?: string;
    socials?: Array<{ type: string; url: string }>;
    websites?: Array<{ label: string; url: string }>;
  };
  safety: {
    honeypot?: 'yes' | 'no' | 'unknown'; buyTax?: number; sellTax?: number;
    mintAuthority?: boolean; freezeAuthority?: boolean;
    lpLocked?: 'yes' | 'no' | 'unknown'; topHoldersPct?: number;
    holdersCount?: number; rugScore?: number; flags: string[];
  };
  playbooks: Playbook[];
  generatedAt: string;
  providers: ProviderStatus[];
  dataSources: string[];
  disclaimer: string;
  kill?: KillResult;
  holderMetrics?: HolderMetrics;
  socialData?: SocialData;
  smartMoney?: SmartMoneyResult;
  aiReasoning?: AiReasoning;
}

/* ── Page ───────────────────────────────────────────────────────────────────── */

export default function TokenAnalyze() {
  const [token, setToken] = useState<ResolvedToken | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);

  function onResolved(t: ResolvedToken | null) {
    setToken(t);
    setReport(null);
    setError(null);
  }

  async function run(e?: React.FormEvent) {
    e?.preventDefault();
    if (!token) { setError('Paste an address or pick a token first.'); return; }
    setLoading(true);
    setError(null);
    setReport(null);
    try {
      const res = await api.post<Report>('/token-analysis/analyze', { address: token.address });
      setReport(res.data);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? e?.message ?? 'Analysis failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page space-y-4">
      <header>
        <div className="section-eyebrow">Token intel</div>
        <h1 className="page-title">Paste an address or $TICKER, get a pro verdict</h1>
        <p className="page-subtitle">
          Chain auto-detected. Type a ticker and we rank every match by popularity. Safety check, holder
          forensics, social signals, and Claude AI reasoning — in seconds.
        </p>
      </header>

      <Section title="Target">
        <form onSubmit={run} className="flex gap-2 flex-wrap items-end">
          <div className="w-full sm:flex-1" style={{ minWidth: 0 }}>
            <TokenSearchInput
              label="Contract address or $TICKER"
              placeholder="Solana / EVM address, or $BONK — chain auto-detected"
              onResolved={onResolved}
              autoFocus
            />
          </div>
          <button className="btn btn-primary w-full sm:w-auto" disabled={loading || !token} style={{ minWidth: 120 }}>
            {loading ? 'Analyzing…' : 'Analyze'}
          </button>
        </form>
        {error && (
          <div
            className="mt-3 px-3 py-2 rounded-[8px] text-[12.5px]"
            style={{
              background: 'color-mix(in srgb, var(--bad) 10%, transparent)',
              border: '1px solid color-mix(in srgb, var(--bad) 40%, var(--border))',
              color: 'var(--bad)',
            }}
          >
            {error}
          </div>
        )}
      </Section>

      {loading && <AnalyzingSkeleton />}
      {report && <ReportView report={report} />}
    </div>
  );
}

/* ── Skeleton ───────────────────────────────────────────────────────────────── */

function AnalyzingSkeleton() {
  return (
    <div className="space-y-3 fade-in">
      {[100, 200, 80, 140, 80].map((h, i) => (
        <div
          key={i}
          className="section"
          style={{ height: h, background: 'var(--surface)', animation: 'pulse 1.6s ease-in-out infinite' }}
        />
      ))}
    </div>
  );
}

/* ── Report root ────────────────────────────────────────────────────────────── */

function ReportView({ report }: { report: Report }) {
  const m = report.meta;
  const [showPlaybooks, setShowPlaybooks] = useState(false);
  return (
    <div className="space-y-4 fade-in">

      {/* 1 — Kill banner */}
      {report.kill?.triggered && <KillBanner kill={report.kill} />}

      {/* 2 — AI Verdict hero (the product) */}
      {report.aiReasoning && !report.kill?.triggered && (
        <VerdictHero ai={report.aiReasoning} />
      )}

      {/* 3 — Token overview strip */}
      <Section
        title={m.symbol ? `${m.symbol}  ${m.name ?? ''}` : m.address.slice(0, 10) + '…'}
        subtitle={`${m.chain} · ${m.dex ?? 'unknown dex'}${m.pairAgeHours != null ? ` · ${fmtAge(m.pairAgeHours)}` : ''}`}
        actions={m.url ? <a className="btn btn-sm" href={m.url} target="_blank" rel="noreferrer">Chart ↗</a> : undefined}
      >
        <div className="grid-stats">
          <Stat label="Price"      value={m.priceUsd  != null ? `$${fmtNum(m.priceUsd, 6)}` : '—'} />
          <Stat label="Market cap" value={m.marketCapUsd != null ? `$${fmtMag(m.marketCapUsd)}` : '—'} />
          <Stat label="Liquidity"  value={m.liquidityUsd != null ? `$${fmtMag(m.liquidityUsd)}` : '—'} />
          <Stat label="Vol 24h"    value={m.volume24hUsd != null ? `$${fmtMag(m.volume24hUsd)}` : '—'} />
          <Stat
            label="24h"
            value={m.priceChange.h24 != null ? fmtPct(m.priceChange.h24) : '—'}
            deltaTone={(m.priceChange.h24 ?? 0) >= 0 ? 'up' : 'down'}
          />
          {m.txns24h && (
            <Stat
              label="Buys / Sells"
              value={`${m.txns24h.buys ?? '?'} / ${m.txns24h.sells ?? '?'}`}
            />
          )}
        </div>
      </Section>

      {/* 4 — Intel evidence panels — THE MISSING PIECE */}
      {!report.kill?.triggered && (
        <IntelEvidenceSection report={report} />
      )}

      {/* 5 — Pipeline trail — what the system did */}
      <PipelineTrail providers={report.providers} generatedAt={report.generatedAt} />

      {/* 6 — Four playbooks (collapsible — secondary to AI verdict) */}
      {!report.kill?.triggered && (
        <div className="section">
          <div
            className="section-header"
            style={{ cursor: 'pointer', userSelect: 'none' }}
            onClick={() => setShowPlaybooks(v => !v)}
          >
            <h3 className="section-title">Playbook scorecards</h3>
            <div className="flex items-center gap-2">
              <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>
                Early Safe · Smart Money · Narrative · Momentum
              </span>
              <span
                className="text-[11px]"
                style={{
                  color: 'var(--text-3)',
                  transform: `rotate(${showPlaybooks ? 180 : 0}deg)`,
                  transition: 'transform 160ms',
                  display: 'inline-block',
                }}
              >
                ▾
              </span>
            </div>
          </div>
          {showPlaybooks && (
            <div className="section-body">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {report.playbooks.map((p) => <PlaybookCard key={p.key} pb={p} />)}
              </div>
            </div>
          )}
        </div>
      )}

      <p className="text-[11.5px]" style={{ color: 'var(--text-3)' }}>
        {report.disclaimer} · Generated {new Date(report.generatedAt).toLocaleTimeString()}
      </p>
    </div>
  );
}

/* ── Kill banner ────────────────────────────────────────────────────────────── */

function KillBanner({ kill }: { kill: KillResult }) {
  return (
    <div
      className="section"
      style={{
        borderColor: 'color-mix(in srgb, var(--bad) 50%, var(--border))',
        background: 'color-mix(in srgb, var(--bad) 8%, var(--surface))',
      }}
    >
      <div className="section-header" style={{ borderColor: 'color-mix(in srgb, var(--bad) 30%, var(--border))' }}>
        <h3 className="section-title" style={{ color: 'var(--bad)' }}>REJECTED — Fatal safety check failed</h3>
        <span className="chip chip-bad">{kill.checkId}</span>
      </div>
      <div className="section-body">
        <p className="text-[13px]" style={{ color: 'var(--text-2)' }}>{kill.reason}</p>
        <p className="text-[12px] mt-2" style={{ color: 'var(--text-3)' }}>
          Analysis stopped. Do not trade this token.
        </p>
      </div>
    </div>
  );
}

/* ── Verdict Hero ───────────────────────────────────────────────────────────── */

const VERDICT_COLORS: Record<AiVerdict, string> = {
  STRONG_BUY: 'var(--ok)',
  BUY:        'var(--ok)',
  CAUTIOUS:   'var(--warn)',
  SKIP:       'var(--bad)',
  HIGH_RISK:  'var(--bad)',
};

const VERDICT_LABELS: Record<AiVerdict, string> = {
  STRONG_BUY: 'STRONG BUY',
  BUY:        'BUY',
  CAUTIOUS:   'CAUTIOUS',
  SKIP:       'SKIP',
  HIGH_RISK:  'HIGH RISK',
};

type CategoryKey = 'safety' | 'market' | 'holders' | 'social' | 'momentum';

const CATEGORY_META: Array<{ key: CategoryKey; label: string; max: number; desc: string }> = [
  { key: 'safety',   label: 'Safety',   max: 30, desc: 'Contract hygiene, LP lock, mint/freeze authority, honeypot' },
  { key: 'market',   label: 'Market',   max: 20, desc: 'Liquidity depth, volume/mcap ratio, buy/sell pressure' },
  { key: 'holders',  label: 'Holders',  max: 20, desc: 'Concentration, deployer behavior, bundle-free launch' },
  { key: 'social',   label: 'Social',   max: 15, desc: 'Community size, website legitimacy, social presence' },
  { key: 'momentum', label: 'Momentum', max: 15, desc: 'Price trend, volume trend, transaction activity' },
];

function VerdictHero({ ai }: { ai: AiReasoning }) {
  const color = VERDICT_COLORS[ai.verdict];
  const [expandedCategory, setExpandedCategory] = useState<CategoryKey | null>(null);

  return (
    <div
      className="section cinematic-rise"
      style={{ borderColor: `color-mix(in srgb, ${color} 30%, var(--border))` }}
    >
      {/* Header row: score ring + verdict */}
      <div
        className="section-header"
        style={{ borderColor: `color-mix(in srgb, ${color} 20%, var(--border))` }}
      >
        <div className="flex items-center gap-4">
          <ScoreRingLarge score={ai.score} color={color} />
          <div>
            <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--font-display)', color, letterSpacing: '-0.02em' }}>
              {VERDICT_LABELS[ai.verdict]}
            </div>
            <div className="text-[11px] uppercase tracking-wider" style={{ color: 'var(--text-3)', marginTop: 2 }}>
              AI verdict · Claude · {ai.score}/100
            </div>
          </div>
        </div>
        <div className="text-[11.5px]" style={{ color: 'var(--text-3)', textAlign: 'right' }}>
          {new Date(ai.generatedAt).toLocaleTimeString()}
        </div>
      </div>

      <div className="section-body space-y-5">
        {/* Summary — THE PRODUCT. Make it unmissable. */}
        <div
          className="rounded-[10px] p-4"
          style={{
            background: `color-mix(in srgb, ${color} 6%, var(--surface-2))`,
            border: `1px solid color-mix(in srgb, ${color} 20%, var(--border))`,
          }}
        >
          <div className="text-[10.5px] uppercase tracking-wider font-semibold mb-2" style={{ color }}>
            AI reasoning
          </div>
          <p className="text-[13.5px] leading-relaxed" style={{ color: 'var(--text)', fontFamily: 'var(--font-sans)' }}>
            {ai.summary}
          </p>
        </div>

        {/* Bullish + Risk side by side */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {ai.bullishSignals.length > 0 && (
            <div>
              <div className="text-[10.5px] uppercase tracking-wider font-semibold mb-2" style={{ color: 'var(--ok)' }}>
                Bullish signals
              </div>
              <ul className="space-y-2">
                {ai.bullishSignals.map((s, i) => (
                  <li key={i} className="text-[12.5px] flex items-start gap-2" style={{ color: 'var(--text-2)' }}>
                    <span
                      className="shrink-0 font-mono font-bold"
                      style={{
                        width: 16, height: 16, borderRadius: 4, marginTop: 1,
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        background: 'color-mix(in srgb, var(--ok) 14%, var(--surface-2))',
                        border: '1px solid color-mix(in srgb, var(--ok) 30%, var(--border))',
                        color: 'var(--ok)', fontSize: 10,
                      }}
                    >
                      +
                    </span>
                    {s}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {ai.riskFactors.length > 0 && (
            <div>
              <div className="text-[10.5px] uppercase tracking-wider font-semibold mb-2" style={{ color: 'var(--warn)' }}>
                Risk factors
              </div>
              <ul className="space-y-2">
                {ai.riskFactors.map((r, i) => (
                  <li key={i} className="text-[12.5px] flex items-start gap-2" style={{ color: 'var(--text-2)' }}>
                    <span
                      className="shrink-0 font-mono font-bold"
                      style={{
                        width: 16, height: 16, borderRadius: 4, marginTop: 1,
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        background: 'color-mix(in srgb, var(--warn) 14%, var(--surface-2))',
                        border: '1px solid color-mix(in srgb, var(--warn) 30%, var(--border))',
                        color: 'var(--warn)', fontSize: 10,
                      }}
                    >
                      !
                    </span>
                    {r}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Category score bars — expandable for per-category reasoning */}
        <div>
          <div className="text-[10.5px] uppercase tracking-wider font-semibold mb-3" style={{ color: 'var(--text-3)' }}>
            Score breakdown — click any category to see reasoning
          </div>
          <div className="space-y-2">
            {CATEGORY_META.map(({ key, label, max, desc }) => {
              const val = ai.categoryScores[key];
              const pct = val / max;
              const barColor = pct >= 0.7 ? 'var(--ok)' : pct >= 0.4 ? 'var(--warn)' : 'var(--bad)';
              const reason = ai.categoryReasons?.[key];
              const isOpen = expandedCategory === key;
              return (
                <div key={key}>
                  <button
                    type="button"
                    onClick={() => setExpandedCategory(isOpen ? null : key)}
                    className="w-full text-left"
                    style={{ background: 'none', border: 'none', cursor: reason ? 'pointer' : 'default', padding: 0 }}
                  >
                    <div className="flex items-center gap-3">
                      <div className="text-[12px] font-semibold" style={{ width: 70, color: 'var(--text-2)', flexShrink: 0 }}>
                        {label}
                      </div>
                      {/* Bar */}
                      <div
                        className="flex-1 rounded-full overflow-hidden"
                        style={{ height: 6, background: 'var(--surface-2)' }}
                      >
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${pct * 100}%`,
                            background: barColor,
                            transition: 'width 600ms ease',
                          }}
                        />
                      </div>
                      <div
                        className="font-mono text-[12px] font-semibold"
                        style={{ width: 44, textAlign: 'right', color: barColor, flexShrink: 0 }}
                      >
                        {val}/{max}
                      </div>
                      {reason && (
                        <span
                          style={{
                            width: 16, flexShrink: 0,
                            transform: `rotate(${isOpen ? 180 : 0}deg)`,
                            transition: 'transform 160ms',
                            display: 'inline-block',
                            color: 'var(--text-3)',
                            fontSize: 10,
                          }}
                        >
                          ▾
                        </span>
                      )}
                    </div>
                  </button>
                  {/* Reason drawer */}
                  {isOpen && reason && (
                    <div
                      className="mt-1.5 px-3 py-2.5 rounded-[8px] text-[12.5px] leading-relaxed cinematic-rise"
                      style={{
                        marginLeft: 82,
                        background: `color-mix(in srgb, ${barColor} 6%, var(--bg-2))`,
                        border: `1px solid color-mix(in srgb, ${barColor} 20%, var(--border))`,
                        color: 'var(--text-2)',
                      }}
                    >
                      <span className="text-[10.5px] uppercase tracking-wider font-semibold block mb-1" style={{ color: barColor }}>
                        Why {val}/{max}
                      </span>
                      {reason}
                    </div>
                  )}
                  {/* No-reason tooltip */}
                  {isOpen && !reason && (
                    <div
                      className="mt-1 px-3 py-1.5 rounded-[8px] text-[11.5px]"
                      style={{ marginLeft: 82, color: 'var(--text-3)' }}
                    >
                      {desc}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Intel Evidence Section ─────────────────────────────────────────────────── */

function IntelEvidenceSection({ report }: { report: Report }) {
  return (
    <Section title="Intelligence report" subtitle="What every analysis layer found — and what it means">
      <div className="space-y-2">
        <SafetyLayer report={report} />
        <MarketLayer report={report} />
        <HolderLayer report={report} />
        <SocialLayer report={report} />
        <SmartMoneyLayer report={report} />
      </div>
    </Section>
  );
}

/* ── Individual evidence layers ─────────────────────────────────────────────── */

function SafetyLayer({ report }: { report: Report }) {
  const [open, setOpen] = useState(true);
  const s = report.safety;
  const reason = report.aiReasoning?.categoryReasons?.safety;

  const hasIssues = s.honeypot === 'yes' || s.mintAuthority === true || s.freezeAuthority === true || s.lpLocked === 'no';
  const allClear = s.honeypot === 'no' && s.mintAuthority === false && s.freezeAuthority === false && (s.lpLocked === 'yes');
  const statusColor = hasIssues ? 'var(--bad)' : allClear ? 'var(--ok)' : 'var(--warn)';
  const statusLabel = hasIssues ? 'Issues found' : allClear ? 'Clean' : 'Partial';

  const provider = report.providers.find(p => p.name === 'RugCheck' || p.name.startsWith('GoPlus'));

  return (
    <EvidenceLayer
      title="Safety layer"
      subtitle={provider ? `${provider.name} · ${provider.status}` : 'No provider'}
      statusColor={statusColor}
      statusLabel={statusLabel}
      open={open}
      onToggle={() => setOpen(v => !v)}
      reason={reason}
      categoryLabel="safety"
      categoryScore={report.aiReasoning?.categoryScores.safety}
      categoryMax={30}
    >
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2">
        <EvidenceRow label="Honeypot" value={s.honeypot ?? '?'} tone={s.honeypot === 'no' ? 'ok' : s.honeypot === 'yes' ? 'bad' : 'warn'} />
        {s.mintAuthority != null && (
          <EvidenceRow label="Mint authority" value={s.mintAuthority ? 'active' : 'revoked'} tone={s.mintAuthority ? 'bad' : 'ok'} />
        )}
        {s.freezeAuthority != null && (
          <EvidenceRow label="Freeze authority" value={s.freezeAuthority ? 'active' : 'revoked'} tone={s.freezeAuthority ? 'bad' : 'ok'} />
        )}
        <EvidenceRow label="LP locked" value={s.lpLocked ?? '?'} tone={s.lpLocked === 'yes' ? 'ok' : s.lpLocked === 'no' ? 'bad' : 'warn'} />
        {s.buyTax  != null && <EvidenceRow label="Buy tax"  value={`${(s.buyTax / 100).toFixed(1)}%`}  tone={s.buyTax >= 500 ? 'bad' : s.buyTax > 0 ? 'warn' : 'ok'} />}
        {s.sellTax != null && <EvidenceRow label="Sell tax" value={`${(s.sellTax / 100).toFixed(1)}%`} tone={s.sellTax >= 500 ? 'bad' : s.sellTax > 0 ? 'warn' : 'ok'} />}
        {s.rugScore != null && (
          <EvidenceRow label="Risk score" value={`${s.rugScore}/100`} tone={s.rugScore >= 80 ? 'bad' : s.rugScore >= 40 ? 'warn' : 'ok'} />
        )}
        {s.holdersCount != null && <EvidenceRow label="Total holders" value={fmtMag(s.holdersCount)} />}
        {s.topHoldersPct != null && (
          <EvidenceRow label="Top-10 hold" value={`${s.topHoldersPct.toFixed(1)}%`} tone={s.topHoldersPct >= 60 ? 'bad' : s.topHoldersPct >= 40 ? 'warn' : 'ok'} />
        )}
      </div>
      {s.flags.length > 0 && (
        <div className="mt-3">
          <div className="text-[10.5px] uppercase tracking-wider font-semibold mb-1.5" style={{ color: 'var(--bad)' }}>
            Risk flags ({s.flags.length})
          </div>
          <ul className="space-y-1">
            {s.flags.map((f, i) => (
              <li key={i} className="text-[12px] flex items-start gap-1.5" style={{ color: 'var(--text-2)' }}>
                <span style={{ color: 'var(--bad)', flexShrink: 0 }}>!</span>{f}
              </li>
            ))}
          </ul>
        </div>
      )}
    </EvidenceLayer>
  );
}

function MarketLayer({ report }: { report: Report }) {
  const [open, setOpen] = useState(true);
  const m = report.meta;
  const reason = report.aiReasoning?.categoryReasons?.market;

  const buys = m.txns24h?.buys ?? 0, sells = m.txns24h?.sells ?? 0, total = buys + sells;
  const buyPct = total ? (buys / total) * 100 : null;
  const volMcapRatio = m.volume24hUsd && m.marketCapUsd ? (m.volume24hUsd / m.marketCapUsd) * 100 : null;

  const hasLiquidity = (m.liquidityUsd ?? 0) > 20_000;
  const statusColor = !hasLiquidity ? 'var(--bad)' : volMcapRatio && volMcapRatio > 5 ? 'var(--ok)' : 'var(--warn)';

  const dexProvider = report.providers.find(p => p.name === 'DexScreener');
  const geckoProvider = report.providers.find(p => p.name === 'GeckoTerminal');

  return (
    <EvidenceLayer
      title="Market structure"
      subtitle={[dexProvider, geckoProvider].filter(Boolean).map(p => `${p!.name} ${p!.status}`).join(' · ')}
      statusColor={statusColor}
      statusLabel={hasLiquidity ? 'Active market' : 'Thin liquidity'}
      open={open}
      onToggle={() => setOpen(v => !v)}
      reason={reason}
      categoryLabel="market"
      categoryScore={report.aiReasoning?.categoryScores.market}
      categoryMax={20}
    >
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2">
        {m.liquidityUsd  != null && <EvidenceRow label="Liquidity"   value={`$${fmtMag(m.liquidityUsd)}`}  tone={(m.liquidityUsd < 5_000) ? 'bad' : m.liquidityUsd < 20_000 ? 'warn' : 'ok'} />}
        {m.volume24hUsd  != null && <EvidenceRow label="Vol 24h"     value={`$${fmtMag(m.volume24hUsd)}`} />}
        {m.marketCapUsd  != null && <EvidenceRow label="Market cap"  value={`$${fmtMag(m.marketCapUsd)}`} />}
        {m.fdvUsd        != null && <EvidenceRow label="FDV"         value={`$${fmtMag(m.fdvUsd)}`} />}
        {volMcapRatio    != null && <EvidenceRow label="Vol/MCap" value={`${volMcapRatio.toFixed(0)}%`} tone={volMcapRatio >= 30 ? 'ok' : volMcapRatio >= 5 ? 'warn' : undefined} />}
        {buyPct != null && (
          <EvidenceRow
            label="Buy pressure"
            value={`${buyPct.toFixed(0)}% (${buys}/${sells})`}
            tone={buyPct >= 60 ? 'ok' : buyPct <= 35 ? 'bad' : undefined}
          />
        )}
        {m.pairAgeHours != null && <EvidenceRow label="Pair age" value={fmtAge(m.pairAgeHours)} tone={m.pairAgeHours < 1 ? 'warn' : undefined} />}
        {m.priceChange.h1  != null && <EvidenceRow label="1h change"  value={fmtPct(m.priceChange.h1)}  tone={m.priceChange.h1 > 0 ? 'ok' : 'bad'} />}
        {m.priceChange.h24 != null && <EvidenceRow label="24h change" value={fmtPct(m.priceChange.h24)} tone={m.priceChange.h24 > 0 ? 'ok' : 'bad'} />}
      </div>
    </EvidenceLayer>
  );
}

function HolderLayer({ report }: { report: Report }) {
  const [open, setOpen] = useState(true);
  const h = report.holderMetrics;
  const s = report.safety;
  const reason = report.aiReasoning?.categoryReasons?.holders;

  const concentration = h?.top10ConcentrationPct ?? s.topHoldersPct;
  const hasData = concentration != null || h?.bundleDetected != null || (h?.totalHolders ?? s.holdersCount) != null;

  const statusColor = h?.bundleDetected ? 'var(--bad)' : concentration && concentration > 50 ? 'var(--warn)' : concentration != null ? 'var(--ok)' : 'var(--text-3)';
  const statusLabel = !hasData ? 'No data' : h?.bundleDetected ? 'Bundle detected' : concentration && concentration < 25 ? 'Well distributed' : 'Review needed';

  const heliusProvider = report.providers.find(p => p.name === 'Helius (holders)');

  return (
    <EvidenceLayer
      title="Holder forensics"
      subtitle={heliusProvider ? `Helius · ${heliusProvider.status}` : 'RugCheck data (partial)'}
      statusColor={statusColor}
      statusLabel={statusLabel}
      open={open}
      onToggle={() => setOpen(v => !v)}
      reason={reason}
      categoryLabel="holders"
      categoryScore={report.aiReasoning?.categoryScores.holders}
      categoryMax={20}
    >
      {hasData ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2">
          {(h?.totalHolders ?? s.holdersCount) != null && (
            <EvidenceRow label="Total holders" value={fmtMag((h?.totalHolders ?? s.holdersCount)!)} />
          )}
          {concentration != null && (
            <EvidenceRow
              label="Top-10 concentration"
              value={`${concentration.toFixed(1)}%`}
              tone={concentration >= 60 ? 'bad' : concentration >= 35 ? 'warn' : 'ok'}
            />
          )}
          {h?.bundleDetected != null && (
            <EvidenceRow
              label="Bundle launch"
              value={h.bundleDetected ? 'detected' : 'clean'}
              tone={h.bundleDetected ? 'bad' : 'ok'}
            />
          )}
          {h?.deployerHoldsPct != null && (
            <EvidenceRow label="Deployer holds" value={`${h.deployerHoldsPct.toFixed(1)}%`} tone={h.deployerHoldsPct > 10 ? 'warn' : 'ok'} />
          )}
        </div>
      ) : (
        <p className="text-[12.5px]" style={{ color: 'var(--text-3)' }}>
          Holder data unavailable — HELIUS_RPC_URL not configured or provider error.
        </p>
      )}
      {h?.bundleDetected && (
        <div className="mt-3 text-[12px] px-3 py-2 rounded-[8px]" style={{ background: 'color-mix(in srgb, var(--bad) 8%, var(--bg-2))', border: '1px solid color-mix(in srgb, var(--bad) 25%, var(--border))', color: 'var(--text-2)' }}>
          Bundle detected at launch — the deployer bought tokens in the same transaction as LP creation, meaning they pre-positioned before anyone could trade. This is a meaningful red flag for insider manipulation.
        </div>
      )}
    </EvidenceLayer>
  );
}

function SocialLayer({ report }: { report: Report }) {
  const [open, setOpen] = useState(false);
  const sd = report.socialData;
  const reason = report.aiReasoning?.categoryReasons?.social;

  const socialProvider = report.providers.find(p => p.name === 'Social');
  const hasAny = sd?.hasSocials;

  const statusColor = !hasAny ? 'var(--text-3)' : sd?.domainAgeDays != null && sd.domainAgeDays < 14 ? 'var(--warn)' : 'var(--ok)';
  const statusLabel = !hasAny ? 'No socials found' : 'Socials present';

  return (
    <EvidenceLayer
      title="Social intelligence"
      subtitle={socialProvider ? `Telegram API + RDAP · ${socialProvider.status}` : 'Not available'}
      statusColor={statusColor}
      statusLabel={statusLabel}
      open={open}
      onToggle={() => setOpen(v => !v)}
      reason={reason}
      categoryLabel="social"
      categoryScore={report.aiReasoning?.categoryScores.social}
      categoryMax={15}
    >
      {sd ? (
        <div className="space-y-3">
          <div className="flex gap-2 flex-wrap">
            {sd.twitterUrl && (
              <a href={sd.twitterUrl} target="_blank" rel="noreferrer" className="chip">
                Twitter ↗
              </a>
            )}
            {sd.telegramUrl && (
              <a href={sd.telegramUrl} target="_blank" rel="noreferrer" className="chip">
                Telegram ↗
              </a>
            )}
            {sd.websiteUrl && (
              <a href={sd.websiteUrl} target="_blank" rel="noreferrer" className="chip">
                Website ↗
              </a>
            )}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2">
            <EvidenceRow label="Twitter" value={sd.twitterUrl ? 'linked' : 'none'} tone={sd.twitterUrl ? 'ok' : undefined} />
            <EvidenceRow label="Telegram" value={sd.telegramUrl ? 'linked' : 'none'} tone={sd.telegramUrl ? 'ok' : undefined} />
            <EvidenceRow label="Website" value={sd.websiteUrl ? 'linked' : 'none'} tone={sd.websiteUrl ? 'ok' : undefined} />
            {sd.telegramMembers != null && (
              <EvidenceRow
                label="TG members"
                value={sd.telegramMembers.toLocaleString()}
                tone={sd.telegramMembers >= 1000 ? 'ok' : sd.telegramMembers >= 100 ? undefined : 'warn'}
              />
            )}
            {sd.domainAgeDays != null && (
              <EvidenceRow
                label="Domain age"
                value={`${sd.domainAgeDays}d`}
                tone={sd.domainAgeDays < 7 ? 'bad' : sd.domainAgeDays < 30 ? 'warn' : 'ok'}
              />
            )}
          </div>
          {!sd.hasSocials && (
            <p className="text-[12px]" style={{ color: 'var(--text-3)' }}>
              No social links in DexScreener data — either very new or unlisted token.
            </p>
          )}
        </div>
      ) : (
        <p className="text-[12.5px]" style={{ color: 'var(--text-3)' }}>Social data not collected.</p>
      )}
    </EvidenceLayer>
  );
}

function SmartMoneyLayer({ report }: { report: Report }) {
  const [open, setOpen] = useState(false);
  const sm = report.smartMoney;
  const reason = report.aiReasoning?.categoryReasons?.momentum;

  const smProvider = report.providers.find(p => p.name === 'Smart Money');
  const statusColor = sm?.holdersFound ? 'var(--ok)' : sm?.walletsChecked === 0 ? 'var(--text-3)' : 'var(--text-3)';

  return (
    <EvidenceLayer
      title="Smart money"
      subtitle={smProvider ? `Helius wallet scan · ${smProvider.status}` : 'Not run (Solana only)'}
      statusColor={statusColor}
      statusLabel={sm?.holdersFound ? `${sm.holdersFound} wallet${sm.holdersFound > 1 ? 's' : ''} holding` : sm?.walletsChecked === 0 ? 'No wallets configured' : 'None holding'}
      open={open}
      onToggle={() => setOpen(v => !v)}
      reason={reason}
      categoryLabel="momentum"
      categoryScore={report.aiReasoning?.categoryScores.momentum}
      categoryMax={15}
    >
      {sm && sm.walletsChecked > 0 ? (
        <div className="space-y-2">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2">
            <EvidenceRow label="Wallets checked" value={String(sm.walletsChecked)} />
            <EvidenceRow
              label="Wallets holding"
              value={String(sm.holdersFound)}
              tone={sm.holdersFound > 0 ? 'ok' : undefined}
            />
          </div>
          {sm.holders.length > 0 && (
            <div>
              <div className="text-[10.5px] uppercase tracking-wider font-semibold mb-1.5" style={{ color: 'var(--ok)' }}>
                Known holders
              </div>
              <ul className="space-y-1">
                {sm.holders.map((h, i) => (
                  <li key={i} className="text-[12.5px]" style={{ color: 'var(--text-2)' }}>
                    <span style={{ color: 'var(--ok)', marginRight: 6 }}>◆</span>{h.label}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-[12.5px]" style={{ color: 'var(--text-3)' }}>
            {report.meta.chain === 'EVM'
              ? 'Smart money wallet scan is Solana-only in the current implementation.'
              : 'No curated smart-money wallets configured. Add wallet addresses to smart-money-wallets.ts to enable this signal.'}
          </p>
        </div>
      )}
    </EvidenceLayer>
  );
}

/* ── Shared evidence layer shell ────────────────────────────────────────────── */

function EvidenceLayer({
  title, subtitle, statusColor, statusLabel, open, onToggle, reason, categoryLabel, categoryScore, categoryMax, children,
}: {
  title: string; subtitle: string; statusColor: string; statusLabel: string;
  open: boolean; onToggle: () => void;
  reason?: string; categoryLabel: string; categoryScore?: number; categoryMax?: number;
  children: ReactNode;
}) {
  return (
    <div
      className="rounded-[10px] overflow-hidden"
      style={{ border: '1px solid var(--border)', background: 'var(--surface-2)' }}
    >
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left"
        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '10px 14px' }}
      >
        <div className="flex items-center gap-3">
          {/* Status dot */}
          <span
            style={{
              width: 7, height: 7, borderRadius: '50%',
              background: statusColor, flexShrink: 0,
              boxShadow: `0 0 5px ${statusColor}`,
            }}
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[12.5px] font-semibold" style={{ color: 'var(--text)' }}>{title}</span>
              <span
                className="chip"
                style={{ fontSize: 10, padding: '1px 6px', color: statusColor, background: `color-mix(in srgb, ${statusColor} 12%, var(--surface))` }}
              >
                {statusLabel}
              </span>
            </div>
            <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-3)' }}>{subtitle}</div>
          </div>
          {/* Category score badge */}
          {categoryScore != null && categoryMax != null && (
            <span
              className="font-mono text-[11.5px] font-semibold"
              style={{
                color: (categoryScore / categoryMax) >= 0.7 ? 'var(--ok)' : (categoryScore / categoryMax) >= 0.4 ? 'var(--warn)' : 'var(--bad)',
              }}
            >
              {categoryScore}/{categoryMax}
            </span>
          )}
          <span
            style={{
              color: 'var(--text-3)', fontSize: 10,
              transform: `rotate(${open ? 180 : 0}deg)`,
              transition: 'transform 160ms',
              display: 'inline-block', flexShrink: 0,
            }}
          >
            ▾
          </span>
        </div>
      </button>

      {open && (
        <div className="px-4 pb-4 pt-1 space-y-3 fade-in">
          {/* AI interpretation of this layer */}
          {reason && (
            <div
              className="px-3 py-2.5 rounded-[8px] text-[12.5px] leading-relaxed"
              style={{
                background: 'color-mix(in srgb, var(--accent-2) 6%, var(--bg-2))',
                border: '1px solid color-mix(in srgb, var(--accent-2) 18%, var(--border))',
              }}
            >
              <span className="text-[10px] uppercase tracking-wider font-semibold block mb-1" style={{ color: 'var(--accent-2)' }}>
                AI interpretation — {categoryLabel}
              </span>
              <span style={{ color: 'var(--text-2)' }}>{reason}</span>
            </div>
          )}
          {children}
        </div>
      )}
    </div>
  );
}

function EvidenceRow({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' | 'bad' }) {
  const color = tone === 'ok' ? 'var(--ok)' : tone === 'warn' ? 'var(--warn)' : tone === 'bad' ? 'var(--bad)' : 'var(--text)';
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-wider" style={{ color: 'var(--text-3)' }}>{label}</div>
      <div className="font-mono text-[12.5px] font-semibold mt-0.5" style={{ color }}>{value}</div>
    </div>
  );
}

/* ── Pipeline Trail ─────────────────────────────────────────────────────────── */

function PipelineTrail({ providers, generatedAt }: { providers: ProviderStatus[]; generatedAt: string }) {
  const [open, setOpen] = useState(false);

  const hits = providers.filter(p => p.status === 'hit').length;
  const misses = providers.filter(p => p.status === 'miss').length;
  const errors = providers.filter(p => p.status === 'error').length;

  return (
    <div className="section">
      <div
        className="section-header"
        style={{ cursor: 'pointer', userSelect: 'none' }}
        onClick={() => setOpen(v => !v)}
      >
        <h3 className="section-title">
          Pipeline trace
          <span className="text-[11px] ml-2 font-normal" style={{ color: 'var(--text-3)' }}>
            {providers.length} providers · {hits} hit · {misses} miss{errors > 0 ? ` · ${errors} error` : ''}
          </span>
        </h3>
        <span
          style={{
            color: 'var(--text-3)', fontSize: 10,
            transform: `rotate(${open ? 180 : 0}deg)`,
            transition: 'transform 160ms', display: 'inline-block',
          }}
        >
          ▾
        </span>
      </div>
      {open && (
        <div className="section-body fade-in">
          <div className="space-y-1">
            {providers.map((p, i) => (
              <div
                key={i}
                className="flex items-center gap-3 py-2 px-3 rounded-[8px]"
                style={{
                  background: 'var(--bg-2)',
                  border: '1px solid var(--border)',
                }}
              >
                <span
                  className="text-[10px] font-mono font-semibold"
                  style={{
                    width: 18, height: 18, borderRadius: 4,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    background: 'var(--surface)',
                    color: 'var(--text-3)',
                  }}
                >
                  {i + 1}
                </span>
                <span className="flex-1 font-mono text-[12px]" style={{ color: 'var(--text-2)' }}>{p.name}</span>
                <span
                  className={`chip ${p.status === 'hit' ? 'chip-ok' : p.status === 'miss' ? 'chip-warn' : p.status === 'error' ? 'chip-bad' : ''}`}
                  style={{ fontSize: 10 }}
                >
                  {p.status}
                </span>
                {p.note && (
                  <span className="text-[11px] max-w-[200px] truncate" style={{ color: 'var(--text-3)' }} title={p.note}>
                    {p.note}
                  </span>
                )}
              </div>
            ))}
          </div>
          <div className="mt-3 text-[11.5px]" style={{ color: 'var(--text-3)' }}>
            Analysis completed at {new Date(generatedAt).toLocaleTimeString()} ·
            {' '}Results cached for 5 minutes
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Playbook card ──────────────────────────────────────────────────────────── */

function PlaybookCard({ pb }: { pb: Playbook }) {
  const [showMath, setShowMath] = useState(false);
  const insufficient = pb.verdict === 'insufficient_data';
  const color =
    insufficient                ? 'var(--text-3)' :
    pb.verdict === 'strong_yes' ? 'var(--ok)' :
    pb.verdict === 'yes'        ? 'var(--ok)' :
    pb.verdict === 'neutral'    ? 'var(--text-2)' :
    pb.verdict === 'no'         ? 'var(--warn)' : 'var(--bad)';
  const verdictLabel =
    insufficient                ? 'INSUFFICIENT DATA' :
    pb.verdict === 'strong_yes' ? 'STRONG BUY SETUP' :
    pb.verdict === 'yes'        ? 'BUY SETUP' :
    pb.verdict === 'neutral'    ? 'NEUTRAL' :
    pb.verdict === 'no'         ? 'AVOID' : 'STRONG AVOID';

  return (
    <Section
      title={pb.label}
      subtitle={verdictLabel}
      actions={pb.score == null ? <NoScore /> : <ScoreRing score={pb.score} color={color} />}
    >
      <p className="text-[12.5px] mb-3" style={{ color: 'var(--text-2)' }}>{pb.description}</p>
      <div className="text-[11px] uppercase tracking-wider font-semibold mb-2" style={{ color: 'var(--text-3)' }}>Signals</div>
      <ul className="space-y-1.5 mb-3">
        {pb.signals.map((s, i) => (
          <li key={i} className="text-[12.5px] flex items-start gap-2">
            <SignalBullet weight={s.weight} />
            <span className="flex-1 min-w-0">
              <span style={{ color: 'var(--text)' }}>{s.label}</span>
              {typeof s.delta === 'number' && s.delta !== 0 && (
                <span className="ml-2 font-mono" style={{ color: s.delta > 0 ? 'var(--ok)' : 'var(--bad)', fontSize: 11 }}>
                  {s.delta > 0 ? '+' : ''}{s.delta.toFixed(1)}
                </span>
              )}
              {s.detail && <span style={{ color: 'var(--text-3)' }}> — {s.detail}</span>}
            </span>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => setShowMath(v => !v)}
        className="btn btn-sm btn-ghost"
        style={{ width: '100%', justifyContent: 'space-between', marginBottom: 12 }}
      >
        <span>{showMath ? 'Hide' : 'Show'} the math · why {pb.score == null ? 'n/a' : pb.score.toFixed(1)}</span>
        <span style={{ transform: `rotate(${showMath ? 180 : 0}deg)`, transition: 'transform 160ms', display: 'inline-block' }}>▾</span>
      </button>
      {showMath && <BreakdownView b={pb.breakdown} score={pb.score} />}
      {pb.plan && (
        <div className="rounded-[10px] p-3" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
          <div className="text-[11px] uppercase tracking-wider font-semibold mb-2" style={{ color: 'var(--text-3)' }}>Trade plan</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[12.5px]">
            <PlanRow label="Size"    value={pb.plan.sizeHint} />
            <PlanRow label="Entry"   value={pb.plan.entry} />
            <PlanRow label="Stop"    value={pb.plan.stop} />
            <PlanRow label="Targets" value={pb.plan.targets.join(' · ')} />
          </div>
          {pb.plan.notes && <div className="mt-2 text-[11.5px]" style={{ color: 'var(--text-3)' }}>{pb.plan.notes}</div>}
        </div>
      )}
    </Section>
  );
}

function BreakdownView({ b, score }: { b: Breakdown; score: number | null }) {
  const sumOfDeltas = b.appliedDeltas.reduce((s, d) => s + d.delta, 0);
  return (
    <div className="rounded-[10px] p-3 mb-3 cinematic-rise" style={{ background: 'var(--bg-2)', border: '1px solid var(--border)' }}>
      <div className="flex items-center justify-between mb-2">
        <div className="text-[11px] uppercase tracking-wider font-semibold" style={{ color: 'var(--text-3)' }}>Score breakdown</div>
        <div className="font-mono text-[11px]" style={{ color: 'var(--text-3)' }}>
          evidence {b.evidenceTotal.toFixed(1)} / {b.evidenceThreshold.toFixed(1)}
        </div>
      </div>
      <BreakdownRow label="Baseline" value={`+${b.baseline.toFixed(1)}`} muted />
      {b.appliedDeltas.length === 0
        ? <BreakdownRow label="(no signals fired)" value="—" muted />
        : b.appliedDeltas.map((d, i) => (
            <BreakdownRow key={i} label={d.label} value={`${d.delta > 0 ? '+' : ''}${d.delta.toFixed(1)}`} color={d.delta > 0 ? 'var(--ok)' : 'var(--bad)'} />
          ))
      }
      <div style={{ height: 1, background: 'var(--border)', margin: '8px 0' }} />
      <BreakdownRow label="Sum" value={`${sumOfDeltas >= 0 ? '+' : ''}${sumOfDeltas.toFixed(1)}`} muted />
      <BreakdownRow label={`Raw (${b.baseline.toFixed(1)} + Σ)`} value={b.raw.toFixed(1)} muted />
      <BreakdownRow label="Clamped [0,10]" value={b.clamped.toFixed(1)} muted />
      <div style={{ height: 1, background: 'var(--border)', margin: '8px 0' }} />
      <div className="flex items-center justify-between">
        <div className="text-[12.5px] font-semibold">Final</div>
        <div className="font-mono" style={{ fontSize: 16, fontWeight: 700, color: score == null ? 'var(--text-3)' : 'var(--text)' }}>
          {score == null ? 'n/a' : score.toFixed(1)}
        </div>
      </div>
    </div>
  );
}

function BreakdownRow({ label, value, muted, color }: { label: ReactNode; value: ReactNode; muted?: boolean; color?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3" style={{ padding: '3px 0' }}>
      <span className="text-[12.5px]" style={{ color: muted ? 'var(--text-3)' : 'var(--text-2)' }}>{label}</span>
      <span className="font-mono text-[12.5px]" style={{ color: color ?? (muted ? 'var(--text-3)' : 'var(--text)') }}>{value}</span>
    </div>
  );
}

function PlanRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-wider" style={{ color: 'var(--text-3)' }}>{label}</div>
      <div style={{ color: 'var(--text)' }}>{value}</div>
    </div>
  );
}

function NoScore() {
  return (
    <div
      style={{
        width: 48, height: 48, borderRadius: 999,
        border: '1px dashed var(--border-2)',
        background: 'var(--surface-2)', color: 'var(--text-3)',
        fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      title="Not enough data to score"
    >
      n/a
    </div>
  );
}

function SignalBullet({ weight }: { weight: Signal['weight'] }) {
  const color =
    weight === 'critical' ? 'var(--bad)' :
    weight === 'positive' ? 'var(--ok)' :
    weight === 'negative' ? 'var(--warn)' : 'var(--text-3)';
  const glyph = weight === 'critical' ? '!' : weight === 'positive' ? '+' : weight === 'negative' ? '–' : '·';
  return (
    <span
      aria-hidden
      className="inline-flex items-center justify-center shrink-0"
      style={{
        width: 16, height: 16, borderRadius: 4, marginTop: 1,
        background: `color-mix(in srgb, ${color} 16%, var(--surface-2))`,
        color,
        border: `1px solid color-mix(in srgb, ${color} 35%, var(--border))`,
        fontSize: 11, fontWeight: 700, lineHeight: 1,
      }}
    >
      {glyph}
    </span>
  );
}

/* ── Score rings ────────────────────────────────────────────────────────────── */

function ScoreRingLarge({ score, color }: { score: number; color: string }) {
  const r = 24, c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  return (
    <div style={{ position: 'relative', width: 64, height: 64, flexShrink: 0 }}>
      <svg width="64" height="64" viewBox="0 0 64 64">
        <circle cx="32" cy="32" r={r} stroke="var(--surface-2)" strokeWidth="4" fill="none" />
        <circle
          cx="32" cy="32" r={r}
          stroke={color} strokeWidth="4" fill="none"
          strokeDasharray={`${c * pct} ${c - c * pct}`}
          strokeLinecap="round"
          transform="rotate(-90 32 32)"
        />
      </svg>
      <span
        className="font-mono"
        style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 16, fontWeight: 700, color,
        }}
      >
        {score}
      </span>
    </div>
  );
}

function ScoreRing({ score, color }: { score: number; color: string }) {
  const pct = Math.max(0, Math.min(10, score)) / 10;
  const r = 18, c = 2 * Math.PI * r;
  return (
    <div style={{ position: 'relative', width: 48, height: 48 }}>
      <svg width="48" height="48" viewBox="0 0 48 48">
        <circle cx="24" cy="24" r={r} stroke="var(--surface-2)" strokeWidth="4" fill="none" />
        <circle
          cx="24" cy="24" r={r}
          stroke={color} strokeWidth="4" fill="none"
          strokeDasharray={`${c * pct} ${c - c * pct}`}
          strokeLinecap="round"
          transform="rotate(-90 24 24)"
        />
      </svg>
      <span
        className="font-mono"
        style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 13, fontWeight: 600, color,
        }}
      >
        {score.toFixed(1)}
      </span>
    </div>
  );
}

/* ── Helpers ────────────────────────────────────────────────────────────────── */

function fmtNum(n: number, maxDec = 2): string {
  if (n === 0) return '0';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: maxDec });
  if (abs >= 0.0001) return n.toFixed(6);
  // DexScreener subscript notation for tiny numbers — never scientific.
  const SUBS = ['₀','₁','₂','₃','₄','₅','₆','₇','₈','₉'];
  const fixed = abs.toFixed(20);
  const after = fixed.split('.')[1] ?? '';
  const m = after.match(/^(0+)(\d+?)0*$/);
  if (!m) return `${sign}${abs.toFixed(8)}`;
  const extra = Math.max(0, m[1].length - 1);
  const sub = String(extra).split('').map((d) => SUBS[+d]).join('');
  return `${sign}0.0${sub}${m[2].slice(0, 4)}`;
}
function fmtMag(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}
function fmtPct(n: number): string { return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`; }
function fmtAge(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m old`;
  if (hours < 48) return `${Math.round(hours)}h old`;
  if (hours < 24 * 60) return `${Math.round(hours / 24)}d old`;
  return `${(hours / 24 / 30).toFixed(1)}mo old`;
}
