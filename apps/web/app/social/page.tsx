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
    <div className="space-y-6">
      <header>
        <h1 className="text-[22px] font-semibold tracking-tight">Social</h1>
        <p className="text-[13px] text-[color:var(--text-2)] mt-1">
          Anonymized leaderboard and wallet copy-trading.
        </p>
      </header>

      {/* Copy trade quick start */}
      <section className="panel">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="section-title mb-0.5">Copy a wallet</h3>
            <div className="text-[11px] text-[color:var(--text-3)]">
              Mirror a wallet's trades with your own risk guardrails
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <input
            value={copyTarget}
            onChange={(e) => setCopyTarget(e.target.value)}
            placeholder="Source wallet address"
            className="input font-mono"
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
          <p
            className="text-[12px] mt-3"
            style={{ color: copyMsg.includes('started') ? 'var(--ok)' : 'var(--bad)' }}
          >
            {copyMsg}
          </p>
        )}
      </section>

      {/* Leaderboard */}
      <section className="panel">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="section-title mb-0.5">Leaderboard · 30 days</h3>
            <div className="text-[11px] text-[color:var(--text-3)]">
              Top anonymized P&L. Names hidden by design.
            </div>
          </div>
        </div>

        {error && <p className="text-[12px] text-[color:var(--bad)] mb-3">{error}</p>}

        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
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
      </section>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="stat-label font-medium pb-3 pr-4 whitespace-nowrap">{children}</th>;
}

function RankBadge({ rank }: { rank: number }) {
  if (rank <= 3) {
    const colors = ['#f0c420', '#d4d4d4', '#cd7f32'];
    return (
      <span
        className="inline-flex w-6 h-6 rounded-full items-center justify-center text-[11px] font-semibold"
        style={{ background: colors[rank - 1], color: '#000' }}
      >
        {rank}
      </span>
    );
  }
  return <span className="text-[color:var(--text-3)]">#{rank}</span>;
}
