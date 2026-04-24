'use client';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { Skeleton } from '../../components/ui/Skeleton';

interface LeaderRow {
  rank: number;
  anonId: string;
  pnlUsd: number;
  winRate?: number;
  trades?: number;
}

export default function Social() {
  const [rows, setRows] = useState<LeaderRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyTarget, setCopyTarget] = useState('');
  const [copyBusy, setCopyBusy] = useState(false);
  const [copyMsg, setCopyMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<LeaderRow[]>('/social/leaderboard')
      .then((r) => { if (!cancelled) setRows(Array.isArray(r.data) ? r.data : []); })
      .catch((e: any) => {
        if (!cancelled) { setError(e?.message ?? 'Failed to load'); setRows([]); }
      });
    return () => { cancelled = true; };
  }, []);

  async function startCopy() {
    if (!copyTarget.trim()) return;
    setCopyBusy(true);
    setCopyMsg(null);
    try {
      await api.post(`/social/copy/${encodeURIComponent(copyTarget.trim())}`);
      setCopyMsg(`Copy-trade agent started for ${copyTarget.slice(0, 6)}…${copyTarget.slice(-4)}`);
      setCopyTarget('');
    } catch (e: any) {
      setCopyMsg(e?.message ?? 'Failed to start copy trade');
    } finally {
      setCopyBusy(false);
    }
  }

  const loading = rows === null;

  return (
    <div className="page space-y-4">
      <header>
        <div className="section-eyebrow">Social</div>
        <h1 className="page-title">Leaderboard &amp; copy</h1>
        <p className="page-subtitle">Anonymized leaderboard and wallet copy-trading.</p>
      </header>

      {/* Copy trade quick start */}
      <section className="section">
        <div className="section-header">
          <div className="min-w-0">
            <h3 className="section-title">Copy a wallet</h3>
            <div className="text-[11px]" style={{ color: 'var(--text-3)' }}>
              Mirror a wallet's trades with your own risk guardrails
            </div>
          </div>
        </div>
        <div className="section-body">
          <div className="flex gap-2 flex-wrap">
            <input
              value={copyTarget}
              onChange={(e) => setCopyTarget(e.target.value)}
              placeholder="Source wallet address"
              className="input font-mono"
              style={{ flex: '1 1 220px', minWidth: 0 }}
            />
            <button
              onClick={startCopy}
              disabled={copyBusy || !copyTarget.trim()}
              className="btn btn-primary"
            >
              {copyBusy ? 'Starting…' : 'Start copy'}
            </button>
          </div>
          {copyMsg && (
            <p className="text-[12px] mt-3" style={{ color: copyMsg.includes('started') ? 'var(--ok)' : 'var(--bad)' }}>
              {copyMsg}
            </p>
          )}
        </div>
      </section>

      {/* Leaderboard */}
      <section className="section">
        <div className="section-header">
          <div className="min-w-0">
            <h3 className="section-title">Leaderboard · 30 days</h3>
            <div className="text-[11px]" style={{ color: 'var(--text-3)' }}>
              Top anonymized P&amp;L. Names hidden by design.
            </div>
          </div>
        </div>
        <div className="section-body-flush">
          {error && <p className="text-[12px] px-4 pt-3" style={{ color: 'var(--bad)' }}>{error}</p>}
        <div className="table-scroll">
          <table className="table" style={{ minWidth: 560 }}>
            <thead>
              <tr className="text-left">
                <Th>Rank</Th>
                <Th>Trader</Th>
                <Th>Trades</Th>
                <Th>Win rate</Th>
                <Th>PnL (USD)</Th>
                <Th> </Th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i} className="border-t border-border">
                    <td className="py-3 pr-4"><Skeleton w={30} h={12} /></td>
                    <td className="py-3 pr-4"><Skeleton w={100} h={12} /></td>
                    <td className="py-3 pr-4"><Skeleton w={40} h={12} /></td>
                    <td className="py-3 pr-4"><Skeleton w={50} h={12} /></td>
                    <td className="py-3 pr-4"><Skeleton w={80} h={12} /></td>
                    <td className="py-3 pr-4"><Skeleton w={60} h={20} rounded="md" /></td>
                  </tr>
                ))
              ) : rows!.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-[color:var(--text-3)] py-10 text-center">
                    Leaderboard is empty right now. Check back soon.
                  </td>
                </tr>
              ) : (
                rows!.map((r) => (
                  <tr key={r.anonId} className="fade-in border-t border-border hover:bg-[color:var(--surface-hover)]">
                    <td className="py-3 pr-4 font-mono">
                      <RankBadge rank={r.rank} />
                    </td>
                    <td className="py-3 pr-4 font-mono text-[color:var(--text-2)]">{r.anonId}</td>
                    <td className="py-3 pr-4 font-mono">{r.trades ?? '—'}</td>
                    <td className="py-3 pr-4 font-mono">
                      {r.winRate != null ? `${(r.winRate * 100).toFixed(1)}%` : '—'}
                    </td>
                    <td
                      className="py-3 pr-4 font-mono"
                      style={{ color: r.pnlUsd >= 0 ? 'var(--ok)' : 'var(--bad)' }}
                    >
                      {r.pnlUsd >= 0 ? '+' : ''}${r.pnlUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </td>
                    <td className="py-3 pr-4">
                      <button
                        onClick={() => { setCopyTarget(r.anonId); }}
                        className="btn btn-sm"
                      >
                        Copy
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        </div>
      </section>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="stat-label font-medium pb-3 pr-4 whitespace-nowrap">{children}</th>;
}

function RankBadge({ rank }: { rank: number }) {
  if (rank <= 3) {
    // Gold / silver / bronze — token-agnostic, visible in both themes
    const tones = [
      { bg: 'color-mix(in srgb, var(--warn) 30%, var(--surface-2))', border: 'color-mix(in srgb, var(--warn) 60%, var(--border))', color: 'var(--warn)' },
      { bg: 'var(--surface-hover)', border: 'var(--border-2)', color: 'var(--text)' },
      { bg: 'color-mix(in srgb, var(--bad) 22%, var(--surface-2))', border: 'color-mix(in srgb, var(--bad) 45%, var(--border))', color: 'var(--bad)' },
    ];
    const t = tones[rank - 1];
    return (
      <span
        className="inline-flex w-6 h-6 rounded-full items-center justify-center text-[11px] font-semibold font-mono"
        style={{ background: t.bg, color: t.color, border: `1px solid ${t.border}` }}
      >
        {rank}
      </span>
    );
  }
  return <span className="font-mono text-[12px]" style={{ color: 'var(--text-3)' }}>#{rank}</span>;
}
