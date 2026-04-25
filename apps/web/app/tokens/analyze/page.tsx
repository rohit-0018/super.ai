'use client';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../../../lib/api';
import { Section } from '../../../components/ui/Section';
import { Stat } from '../../../components/ui/Stat';

/* ------------- Types mirror the API contract ------------- */

type Chain = 'SOLANA' | 'EVM';
type Verdict = 'strong_yes' | 'yes' | 'neutral' | 'no' | 'strong_no' | 'insufficient_data';

interface ProviderStatus {
  name: string;
  status: 'hit' | 'miss' | 'error' | 'skipped';
  note?: string;
}
type PlaybookKey = 'early_safe' | 'smart_money' | 'narrative' | 'momentum';

interface Signal {
  label: string;
  weight: 'critical' | 'positive' | 'negative' | 'info';
  detail?: string;
  delta?: number;
}

interface Breakdown {
  baseline: number;
  appliedDeltas: { label: string; delta: number; weight: Signal['weight'] }[];
  raw: number;
  clamped: number;
  evidenceTotal: number;
  evidenceThreshold: number;
}

interface Plan {
  sizeHint: string;
  entry: string;
  stop: string;
  targets: string[];
  notes?: string;
}

interface Playbook {
  key: PlaybookKey;
  label: string;
  description: string;
  score: number | null;
  verdict: Verdict;
  signals: Signal[];
  breakdown: Breakdown;
  plan?: Plan;
}

interface Report {
  meta: {
    chain: Chain;
    address: string;
    symbol?: string;
    name?: string;
    priceUsd?: number;
    marketCapUsd?: number;
    liquidityUsd?: number;
    volume24hUsd?: number;
    priceChange: { m5?: number; h1?: number; h6?: number; h24?: number };
    pairAgeHours?: number;
    dex?: string;
    url?: string;
  };
  safety: {
    honeypot?: 'yes' | 'no' | 'unknown';
    buyTax?: number; sellTax?: number;
    mintAuthority?: boolean; freezeAuthority?: boolean;
    lpLocked?: 'yes' | 'no' | 'unknown';
    topHoldersPct?: number; holdersCount?: number;
    rugScore?: number;
    flags: string[];
  };
  playbooks: Playbook[];
  generatedAt: string;
  providers: ProviderStatus[];
  dataSources: string[];
  disclaimer: string;
}

export default function TokenAnalyze() {
  const [chain, setChain] = useState<Chain>('SOLANA');
  const [address, setAddress] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);

  async function run(e?: React.FormEvent) {
    e?.preventDefault();
    const trimmed = address.trim();
    if (!trimmed) { setError('Paste a token contract address.'); return; }
    setLoading(true);
    setError(null);
    setReport(null);
    try {
      const res = await api.get<Report>(`/token-analysis/${chain}/${trimmed}`);
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
        <div className="section-eyebrow">Token analysis</div>
        <h1 className="page-title">Paste an address, get a pro playbook</h1>
        <p className="page-subtitle">
          Four trader playbooks — Early+Safe sniping, Smart-money confluence, Narrative bet, Momentum scalp — scored with safety and market signals.
        </p>
      </header>

      <Section title="Target">
        <form onSubmit={run} className="flex gap-2 flex-wrap items-end">
          <div style={{ minWidth: 120 }}>
            <label className="label">Chain</label>
            <select className="input" value={chain} onChange={(e) => setChain(e.target.value as Chain)}>
              <option value="SOLANA">Solana</option>
              <option value="EVM">EVM (Ethereum)</option>
            </select>
          </div>
          <div style={{ flex: '1 1 320px', minWidth: 0 }}>
            <label className="label">Contract / mint address</label>
            <input
              className="input mono"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder={chain === 'SOLANA' ? 'e.g. EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' : '0x…'}
            />
          </div>
          <button className="btn btn-primary" disabled={loading}>
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

      {report && <ReportView report={report} />}
    </div>
  );
}

function ReportView({ report }: { report: Report }) {
  const m = report.meta;
  return (
    <>
      {/* Meta strip */}
      <Section
        title={m.symbol ? `${m.symbol} · ${m.name ?? ''}` : m.address.slice(0, 10) + '…'}
        subtitle={`${m.chain} · ${m.dex ?? 'unknown dex'}${m.pairAgeHours != null ? ` · ${fmtAge(m.pairAgeHours)}` : ''}`}
        actions={m.url ? <a className="btn btn-sm" href={m.url} target="_blank" rel="noreferrer">Chart ↗</a> : undefined}
      >
        <div className="grid-stats">
          <Stat label="Price" value={m.priceUsd != null ? `$${fmtNum(m.priceUsd, 6)}` : '—'} />
          <Stat label="Market cap"  value={m.marketCapUsd  != null ? `$${fmtMag(m.marketCapUsd)}`  : '—'} />
          <Stat label="Liquidity"   value={m.liquidityUsd  != null ? `$${fmtMag(m.liquidityUsd)}`  : '—'} />
          <Stat label="Volume 24h"  value={m.volume24hUsd  != null ? `$${fmtMag(m.volume24hUsd)}`  : '—'} />
          <Stat
            label="24h change"
            value={m.priceChange.h24 != null ? fmtPct(m.priceChange.h24) : '—'}
            deltaTone={(m.priceChange.h24 ?? 0) >= 0 ? 'up' : 'down'}
          />
        </div>
      </Section>

      {/* Safety strip */}
      <Section title="Safety snapshot">
        <div className="flex gap-2 flex-wrap">
          <SafetyChip label="Honeypot" value={labelTri(report.safety.honeypot)} tone={report.safety.honeypot === 'no' ? 'ok' : report.safety.honeypot === 'yes' ? 'bad' : undefined} />
          <SafetyChip label="LP locked" value={labelTri(report.safety.lpLocked)} tone={report.safety.lpLocked === 'yes' ? 'ok' : report.safety.lpLocked === 'no' ? 'bad' : undefined} />
          {report.safety.buyTax != null && <SafetyChip label="Buy tax" value={`${(report.safety.buyTax / 100).toFixed(1)}%`} tone={report.safety.buyTax >= 500 ? 'bad' : undefined} />}
          {report.safety.sellTax != null && <SafetyChip label="Sell tax" value={`${(report.safety.sellTax / 100).toFixed(1)}%`} tone={report.safety.sellTax >= 500 ? 'bad' : undefined} />}
          {report.safety.rugScore != null && <SafetyChip label="Rug score" value={`${report.safety.rugScore}/100`} tone={report.safety.rugScore >= 60 ? 'bad' : report.safety.rugScore >= 30 ? 'warn' : 'ok'} />}
          {report.safety.holdersCount != null && <SafetyChip label="Holders" value={fmtMag(report.safety.holdersCount)} />}
          {report.safety.topHoldersPct != null && <SafetyChip label="Top-10 hold" value={`${report.safety.topHoldersPct.toFixed(1)}%`} tone={report.safety.topHoldersPct >= 60 ? 'bad' : report.safety.topHoldersPct >= 40 ? 'warn' : 'ok'} />}
          {report.safety.mintAuthority === true && <SafetyChip label="Mint auth" value="enabled" tone="bad" />}
          {report.safety.freezeAuthority === true && <SafetyChip label="Freeze auth" value="enabled" tone="bad" />}
        </div>
        {report.safety.flags.length > 0 && (
          <ul className="mt-3 space-y-1">
            {report.safety.flags.map((f, i) => (
              <li key={i} className="text-[12.5px] flex gap-2" style={{ color: 'var(--text-2)' }}>
                <span style={{ color: 'var(--bad)' }}>!</span>
                <span>{f}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Provider status */}
      <Section title="Data sources" subtitle="Per-provider status for this run">
        <div className="flex gap-2 flex-wrap">
          {report.providers.map((p) => (
            <ProviderChip key={p.name} p={p} />
          ))}
        </div>
      </Section>

      {/* Four playbooks */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {report.playbooks.map((p) => <PlaybookCard key={p.key} pb={p} />)}
      </div>

      <p className="text-[11.5px]" style={{ color: 'var(--text-3)' }}>
        {report.disclaimer} · Generated {new Date(report.generatedAt).toLocaleTimeString()}
      </p>
    </>
  );
}

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
                <span
                  className="ml-2 font-mono"
                  style={{ color: s.delta > 0 ? 'var(--ok)' : 'var(--bad)', fontSize: 11 }}
                >
                  {s.delta > 0 ? '+' : ''}{s.delta.toFixed(1)}
                </span>
              )}
              {s.detail && <span style={{ color: 'var(--text-3)' }}> — {s.detail}</span>}
            </span>
          </li>
        ))}
      </ul>

      {/* Score breakdown — click to expand */}
      <button
        type="button"
        onClick={() => setShowMath((v) => !v)}
        className="btn btn-sm btn-ghost"
        style={{ width: '100%', justifyContent: 'space-between', marginBottom: 12 }}
      >
        <span>{showMath ? 'Hide' : 'Show'} the math · why {pb.score == null ? 'n/a' : pb.score.toFixed(1)}</span>
        <span style={{ transform: `rotate(${showMath ? 180 : 0}deg)`, transition: 'transform 160ms' }}>▾</span>
      </button>
      {showMath && <Breakdown b={pb.breakdown} score={pb.score} />}

      {pb.plan && (
        <div
          className="rounded-[10px] p-3"
          style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}
        >
          <div className="text-[11px] uppercase tracking-wider font-semibold mb-2" style={{ color: 'var(--text-3)' }}>Trade plan</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[12.5px]">
            <Plan label="Size"     value={pb.plan.sizeHint} />
            <Plan label="Entry"    value={pb.plan.entry} />
            <Plan label="Stop"     value={pb.plan.stop} />
            <Plan label="Targets"  value={pb.plan.targets.join(' · ')} />
          </div>
          {pb.plan.notes && <div className="mt-2 text-[11.5px]" style={{ color: 'var(--text-3)' }}>{pb.plan.notes}</div>}
        </div>
      )}
    </Section>
  );
}

function Breakdown({ b, score }: { b: Breakdown; score: number | null }) {
  const sumOfDeltas = b.appliedDeltas.reduce((s, d) => s + d.delta, 0);
  return (
    <div
      className="rounded-[10px] p-3 mb-3 cinematic-rise"
      style={{ background: 'var(--bg-2)', border: '1px solid var(--border)' }}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="text-[11px] uppercase tracking-wider font-semibold" style={{ color: 'var(--text-3)' }}>Score breakdown</div>
        <div className="font-mono text-[11px]" style={{ color: 'var(--text-3)' }}>
          evidence {b.evidenceTotal.toFixed(1)} / {b.evidenceThreshold.toFixed(1)}
        </div>
      </div>

      <BreakdownRow label="Baseline" value={`+${b.baseline.toFixed(1)}`} muted />
      {b.appliedDeltas.length === 0 ? (
        <BreakdownRow label="(no signals fired)" value="—" muted />
      ) : (
        b.appliedDeltas.map((d, i) => (
          <BreakdownRow
            key={i}
            label={d.label}
            value={`${d.delta > 0 ? '+' : ''}${d.delta.toFixed(1)}`}
            color={d.delta > 0 ? 'var(--ok)' : 'var(--bad)'}
          />
        ))
      )}
      <div style={{ height: 1, background: 'var(--border)', margin: '8px 0' }} />
      <BreakdownRow
        label="Sum of deltas"
        value={`${sumOfDeltas >= 0 ? '+' : ''}${sumOfDeltas.toFixed(1)}`}
        muted
      />
      <BreakdownRow
        label={`Raw (${b.baseline.toFixed(1)} + Σ)`}
        value={b.raw.toFixed(1)}
        muted
      />
      <BreakdownRow
        label="Clamped to [0, 10]"
        value={b.clamped.toFixed(1)}
        muted
      />
      <div style={{ height: 1, background: 'var(--border)', margin: '8px 0' }} />
      <div className="flex items-center justify-between">
        <div className="text-[12.5px] font-semibold">Final score</div>
        <div
          className="font-mono"
          style={{
            fontSize: 16, fontWeight: 700,
            color: score == null ? 'var(--text-3)' : 'var(--text)',
          }}
        >
          {score == null ? 'n/a · insufficient' : score.toFixed(1)}
        </div>
      </div>
      {score == null && (
        <div className="text-[11px] mt-2" style={{ color: 'var(--text-3)' }}>
          Evidence total ({b.evidenceTotal.toFixed(1)}) is below this playbook's threshold ({b.evidenceThreshold.toFixed(1)}).
          Add provider data (e.g. Birdeye Pro for Solana volume / holders, or Nansen for smart-money labels) to commit a score.
        </div>
      )}
    </div>
  );
}

function BreakdownRow({ label, value, muted, color }: { label: ReactNode; value: ReactNode; muted?: boolean; color?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3" style={{ padding: '3px 0' }}>
      <span className="text-[12.5px]" style={{ color: muted ? 'var(--text-3)' : 'var(--text-2)' }}>
        {label}
      </span>
      <span className="font-mono text-[12.5px]" style={{ color: color ?? (muted ? 'var(--text-3)' : 'var(--text)') }}>
        {value}
      </span>
    </div>
  );
}

function Plan({ label, value }: { label: string; value: string }) {
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
        background: 'var(--surface-2)',
        color: 'var(--text-3)',
        fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      title="Not enough data to score"
    >
      n/a
    </div>
  );
}

function ProviderChip({ p }: { p: ProviderStatus }) {
  const cls =
    p.status === 'hit'     ? 'chip chip-ok' :
    p.status === 'miss'    ? 'chip chip-warn' :
    p.status === 'error'   ? 'chip chip-bad' :
    'chip';
  return (
    <span className={cls} title={p.note || p.status}>
      <span style={{ fontFamily: 'var(--font-mono)' }}>{p.name}</span>
      <span style={{ marginLeft: 4, opacity: 0.85, textTransform: 'uppercase', fontSize: 10 }}>{p.status}</span>
    </span>
  );
}

function ScoreRing({ score, color }: { score: number; color: string }) {
  const pct = Math.max(0, Math.min(10, score)) / 10;
  const r = 18, c = 2 * Math.PI * r;
  const dash = c * pct;
  return (
    <div style={{ position: 'relative', width: 48, height: 48 }}>
      <svg width="48" height="48" viewBox="0 0 48 48">
        <circle cx="24" cy="24" r={r} stroke="var(--surface-2)" strokeWidth="4" fill="none" />
        <circle
          cx="24" cy="24" r={r}
          stroke={color} strokeWidth="4" fill="none"
          strokeDasharray={`${dash} ${c - dash}`}
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
          letterSpacing: '-0.02em',
        }}
      >
        {score.toFixed(1)}
      </span>
    </div>
  );
}

function SignalBullet({ weight }: { weight: Signal['weight'] }) {
  const color =
    weight === 'critical' ? 'var(--bad)' :
    weight === 'positive' ? 'var(--ok)' :
    weight === 'negative' ? 'var(--warn)' :
    'var(--text-3)';
  const glyph =
    weight === 'critical' ? '!' :
    weight === 'positive' ? '+' :
    weight === 'negative' ? '–' : '·';
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

function SafetyChip({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' | 'bad' }) {
  const cls = tone === 'ok' ? 'chip chip-ok' : tone === 'warn' ? 'chip chip-warn' : tone === 'bad' ? 'chip chip-bad' : 'chip';
  return (
    <span className={cls}>
      <span style={{ color: 'var(--text-3)' }}>{label}</span>
      <span style={{ marginLeft: 4, fontFamily: 'var(--font-mono)' }}>{value}</span>
    </span>
  );
}

function labelTri(v?: 'yes' | 'no' | 'unknown'): string {
  return v === 'yes' ? 'yes' : v === 'no' ? 'no' : '?';
}
function fmtNum(n: number, maxDec = 2): string {
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: maxDec });
  if (abs >= 0.0001) return n.toFixed(6);
  return n.toExponential(2);
}
function fmtMag(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}
function fmtPct(n: number): string { return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`; }
function fmtAge(hours: number): string {
  if (hours < 48) return `${Math.round(hours)}h old`;
  if (hours < 24 * 60) return `${Math.round(hours / 24)}d old`;
  return `${(hours / 24 / 30).toFixed(1)}mo old`;
}
