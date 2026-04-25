'use client';
import { useState } from 'react';
import { api } from '../../../lib/api';
import { Section } from '../../../components/ui/Section';
import { Stat } from '../../../components/ui/Stat';

type Chain = 'SOLANA' | 'EVM';
type RiskProfile = 'sniper' | 'momentum' | 'swing' | 'holder' | 'mixed' | 'insufficient';

interface WindowStats {
  windowDays: number;
  trades: number;
  winRate: number | null;
  pnlUsd: number | null;
  avgHoldHours: number | null;
  bestTradePnl?: number | null;
  worstTradePnl?: number | null;
}

interface CopyFit {
  verdict: 'copy_with_scaling' | 'watch_only' | 'avoid' | 'insufficient_data';
  score: number;
  reasons: string[];
  suggestedScale: number;
}

interface Report {
  chain: Chain;
  address: string;
  labels: string[];
  firstSeen?: string;
  lastActive?: string;
  windows: WindowStats[];
  riskProfile: RiskProfile;
  topTokens: { symbol?: string; address: string; sharePct: number; pnlUsd?: number; tradesCount?: number }[];
  copyFit: CopyFit;
  dataSources: string[];
  coverageNote: string;
  generatedAt: string;
  disclaimer: string;
}

export default function WalletAnalyze() {
  const [chain, setChain] = useState<Chain>('SOLANA');
  const [address, setAddress] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);

  async function run(e?: React.FormEvent) {
    e?.preventDefault();
    const trimmed = address.trim();
    if (!trimmed) { setError('Paste a wallet address.'); return; }
    setLoading(true);
    setError(null);
    setReport(null);
    try {
      const res = await api.get<Report>(`/wallet-analysis/${chain}/${trimmed}`);
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
        <div className="section-eyebrow">Wallet analysis</div>
        <h1 className="page-title">Trader scorecard &amp; copy-fit</h1>
        <p className="page-subtitle">
          Paste any wallet to see its activity profile, risk classifier, and a "safe to copy?" verdict.
        </p>
      </header>

      <Section title="Target wallet">
        <form onSubmit={run} className="flex gap-2 flex-wrap items-end">
          <div style={{ minWidth: 120 }}>
            <label className="label">Chain</label>
            <select className="input" value={chain} onChange={(e) => setChain(e.target.value as Chain)}>
              <option value="SOLANA">Solana</option>
              <option value="EVM">EVM (Ethereum)</option>
            </select>
          </div>
          <div style={{ flex: '1 1 320px', minWidth: 0 }}>
            <label className="label">Wallet address</label>
            <input
              className="input mono"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder={chain === 'SOLANA' ? '9WzDX…' : '0x…'}
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
  return (
    <>
      {/* Header card */}
      <Section
        title={<span className="font-mono">{report.address.slice(0, 8)}…{report.address.slice(-6)}</span>}
        subtitle={`${report.chain} · profile: ${report.riskProfile}`}
        actions={
          <div className="flex gap-2 flex-wrap">
            {report.labels.map((l, i) => (
              <span key={i} className="chip">{l}</span>
            ))}
          </div>
        }
      >
        <div className="grid-stats">
          <Stat
            label="First seen"
            value={report.firstSeen ? new Date(report.firstSeen).toLocaleDateString() : '—'}
            hint={report.firstSeen ? ageDaysLabel(report.firstSeen) : undefined}
          />
          <Stat
            label="Last active"
            value={report.lastActive ? timeAgo(report.lastActive) : '—'}
          />
          <Stat label="30d trades" value={num(report.windows.find((w) => w.windowDays === 30)?.trades)} />
          <Stat label="Sources" value={report.dataSources.join(', ') || '—'} size="sm" />
        </div>
      </Section>

      {/* Copy-fit verdict */}
      <CopyFitCard fit={report.copyFit} />

      {/* Window stats */}
      <Section title="Activity windows" subtitle="Counts only on free tier — see coverage note below">
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Window</th>
                <th className="num">Trades</th>
                <th className="num">Win rate</th>
                <th className="num">PnL (USD)</th>
                <th className="num">Avg hold</th>
              </tr>
            </thead>
            <tbody>
              {report.windows.map((w) => (
                <tr key={w.windowDays}>
                  <td className="font-mono">{w.windowDays}d</td>
                  <td className="num">{num(w.trades)}</td>
                  <td className="num">{w.winRate != null ? `${(w.winRate * 100).toFixed(1)}%` : <Dash />}</td>
                  <td className="num">{w.pnlUsd != null ? `$${w.pnlUsd.toFixed(0)}` : <Dash />}</td>
                  <td className="num">{w.avgHoldHours != null ? `${w.avgHoldHours.toFixed(1)}h` : <Dash />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div
          className="mt-3 px-3 py-2 rounded-[8px] text-[12px]"
          style={{
            background: 'color-mix(in srgb, var(--warn) 8%, var(--surface-2))',
            border: '1px solid color-mix(in srgb, var(--warn) 30%, var(--border))',
            color: 'var(--text-2)',
          }}
        >
          <strong style={{ color: 'var(--warn)' }}>Coverage:</strong> {report.coverageNote}
        </div>
      </Section>

      <p className="text-[11.5px]" style={{ color: 'var(--text-3)' }}>
        {report.disclaimer}
      </p>
    </>
  );
}

function CopyFitCard({ fit }: { fit: CopyFit }) {
  const label =
    fit.verdict === 'copy_with_scaling' ? 'Copy-fit: scale down and mirror' :
    fit.verdict === 'watch_only'        ? 'Copy-fit: watch only, do not mirror' :
    fit.verdict === 'avoid'             ? 'Copy-fit: avoid copying' :
    'Copy-fit: insufficient data';
  const color =
    fit.verdict === 'copy_with_scaling' ? 'var(--ok)' :
    fit.verdict === 'watch_only'        ? 'var(--warn)' :
    fit.verdict === 'avoid'             ? 'var(--bad)' : 'var(--text-3)';
  return (
    <Section
      title="Safe to copy?"
      subtitle={label}
      actions={
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 48, height: 48, borderRadius: 999,
            background: `color-mix(in srgb, ${color} 16%, var(--surface-2))`,
            border: `1px solid color-mix(in srgb, ${color} 40%, var(--border))`,
            color,
            fontFamily: 'var(--font-mono)',
            fontWeight: 600,
            fontSize: 14,
          }}
        >
          {fit.score.toFixed(1)}
        </div>
      }
    >
      <ul className="space-y-1.5">
        {fit.reasons.map((r, i) => (
          <li key={i} className="text-[12.5px] flex gap-2" style={{ color: 'var(--text-2)' }}>
            <span style={{ color }}>·</span>
            <span>{r}</span>
          </li>
        ))}
      </ul>
      {fit.suggestedScale > 0 && (
        <div
          className="mt-3 px-3 py-2 rounded-[8px] text-[12.5px]"
          style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}
        >
          <strong style={{ color: 'var(--text) ' }}>Suggested scale:</strong>{' '}
          <span className="font-mono">{(fit.suggestedScale * 100).toFixed(0)}%</span>{' '}
          of the target's position size. (Free-tier scale is conservative — PnL history is not verified.)
        </div>
      )}
    </Section>
  );
}

function Dash() { return <span style={{ color: 'var(--text-3)' }}>—</span>; }
function num(n?: number | null) { if (n == null) return '—'; return n.toLocaleString(); }
function ageDaysLabel(iso: string): string {
  const d = (Date.now() - new Date(iso).getTime()) / 86_400_000;
  if (d < 1) return '< 1 day';
  if (d < 30) return `${Math.round(d)}d`;
  if (d < 365) return `${Math.round(d / 30)}mo`;
  return `${(d / 365).toFixed(1)}y`;
}
function timeAgo(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}
