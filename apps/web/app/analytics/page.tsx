'use client';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { Skeleton } from '../../components/ui/Skeleton';

interface Performance {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  sharpe: number;
  avgHoldMinutes?: number;
  cumulativeReturns?: number[];
  weekly?: {
    trades: number;
    pnl: number;
    wins: number;
    losses: number;
    winRate: number;
  };
}

interface Trade {
  id: string;
  createdAt: string;
  side: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  amountOut: number;
  pnlUsd?: number | null;
  mode?: string;
}

export default function Analytics() {
  const [perf, setPerf] = useState<Performance | null>(null);
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get<Performance>('/analytics/performance').catch(() => null),
      api.get<Trade[]>('/analytics/replay').catch(() => null),
    ]).then(([p, r]) => {
      if (cancelled) return;
      if (!p && !r) setError('Failed to load analytics');
      const rawPerf = (p?.data ?? {}) as Partial<Performance>;
      setPerf({
        totalTrades: rawPerf.totalTrades ?? 0,
        wins: rawPerf.wins ?? 0,
        losses: rawPerf.losses ?? 0,
        winRate: rawPerf.winRate ?? 0,
        totalPnl: rawPerf.totalPnl ?? 0,
        avgPnl: rawPerf.avgPnl ?? 0,
        sharpe: rawPerf.sharpe ?? 0,
      });
      setTrades(Array.isArray(r?.data) ? (r!.data as Trade[]) : []);
    });
    return () => { cancelled = true; };
  }, []);

  const loading = perf === null || trades === null;

  return (
    <div className="page space-y-4">
      <header className="page-header">
        <div>
          <div className="section-eyebrow">Analytics</div>
          <h1 className="page-title">Performance</h1>
          <p className="page-subtitle">P&amp;L, win rate, and trade diagnostics.</p>
        </div>
        <a
          href={`${process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:4400/api'}/analytics/tax`}
          target="_blank"
          rel="noreferrer"
          className="btn btn-sm"
        >
          Export tax CSV
        </a>
      </header>

      {error && (
        <div className="section" style={{ color: 'var(--bad)' }}>
          <div className="section-body">{error}</div>
        </div>
      )}

      {/* Stats grid */}
      <section className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 md:gap-4">
        <StatCard label="Total P&L" value={loading ? null : fmtUsd(perf!.totalPnl)} accent={loading ? undefined : (perf!.totalPnl >= 0 ? 'var(--ok)' : 'var(--bad)')} />
        <StatCard label="Win rate" value={loading ? null : `${(perf!.winRate * 100).toFixed(1)}%`} />
        <StatCard label="Trades" value={loading ? null : `${perf!.totalTrades}`} sub={loading ? undefined : `${perf!.wins}W · ${perf!.losses}L`} />
        <StatCard label="Sharpe" value={loading ? null : perf!.sharpe.toFixed(2)} sub={loading ? undefined : 'annualized'} />
        <StatCard label="Avg hold" value={loading ? null : formatHoldTime(perf!.avgHoldMinutes ?? 0)} />
        <StatCard label="Avg P&L" value={loading ? null : fmtUsd(perf!.avgPnl)} accent={loading ? undefined : (perf!.avgPnl >= 0 ? 'var(--ok)' : 'var(--bad)')} />
      </section>

      {/* Weekly review card (L8) */}
      {!loading && perf!.weekly && (
        <section className="panel fade-in" style={{ background: 'linear-gradient(135deg, color-mix(in srgb, var(--accent) 6%, var(--surface)) 0%, var(--surface) 60%)' }}>
          <h2 className="section-title mb-4">Weekly review · Last 7 days</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <MiniStat label="Trades" value={`${perf!.weekly.trades}`} />
            <MiniStat label="P&L" value={fmtUsd(perf!.weekly.pnl)} accent={perf!.weekly.pnl >= 0 ? 'var(--ok)' : 'var(--bad)'} />
            <MiniStat label="Win rate" value={`${(perf!.weekly.winRate * 100).toFixed(1)}%`} />
            <MiniStat label="W / L" value={`${perf!.weekly.wins} / ${perf!.weekly.losses}`} />
          </div>
        </section>
      )}

      {/* Cumulative returns sparkline (L7) */}
      {!loading && perf!.cumulativeReturns && perf!.cumulativeReturns.length > 1 && (
        <section className="panel fade-in">
          <h2 className="section-title mb-4">Cumulative P&L curve</h2>
          <CumulativeChart data={perf!.cumulativeReturns} />
        </section>
      )}

      {/* Trade replay */}
      <section className="panel">
        <div className="flex items-center justify-between mb-4">
          <h2 className="section-title mb-0">Trade replay</h2>
          {!loading && trades && (
            <span className="text-[11px] text-[color:var(--text-3)]">{trades.length} trades</span>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left">
                <Th>Time</Th>
                <Th>Side</Th>
                <Th>In</Th>
                <Th>Out</Th>
                <Th>Amount</Th>
                <Th>P&L</Th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i} className="border-t border-border">
                    <td className="py-3 pr-4"><Skeleton w={130} h={12} /></td>
                    <td className="py-3 pr-4"><Skeleton w={50} h={20} rounded="md" /></td>
                    <td className="py-3 pr-4"><Skeleton w={60} h={12} /></td>
                    <td className="py-3 pr-4"><Skeleton w={60} h={12} /></td>
                    <td className="py-3 pr-4"><Skeleton w={80} h={12} /></td>
                    <td className="py-3 pr-4"><Skeleton w={60} h={12} /></td>
                  </tr>
                ))
              ) : trades!.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-[color:var(--text-3)] py-10 text-center">
                    No trades yet. Once you execute, replay shows up here.
                  </td>
                </tr>
              ) : (
                trades!.map((t) => (
                  <tr key={t.id} className="fade-in border-t border-border hover:bg-[color:var(--surface-hover)]">
                    <td className="py-3 pr-4 font-mono text-[color:var(--text-2)] whitespace-nowrap">
                      {new Date(t.createdAt).toLocaleString()}
                    </td>
                    <td className="py-3 pr-4"><span className="chip">{t.side}</span></td>
                    <td className="py-3 pr-4 font-mono">{(t.tokenIn || '').slice(0, 8)}</td>
                    <td className="py-3 pr-4 font-mono">{(t.tokenOut || '').slice(0, 8)}</td>
                    <td className="py-3 pr-4 font-mono">{t.amountIn != null ? Number(t.amountIn).toLocaleString(undefined, { maximumFractionDigits: 4 }) : '—'}</td>
                    <td
                      className="py-3 pr-4 font-mono"
                      style={{
                        color:
                          t.pnlUsd == null
                            ? 'var(--text-3)'
                            : t.pnlUsd > 0
                            ? 'var(--ok)'
                            : t.pnlUsd < 0
                            ? 'var(--bad)'
                            : 'var(--text-2)',
                      }}
                    >
                      {t.pnlUsd == null ? '—' : `${t.pnlUsd >= 0 ? '+' : ''}${t.pnlUsd.toFixed(2)}`}
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

const EMPTY_PERF: Performance = {
  totalTrades: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0, avgPnl: 0, sharpe: 0,
  avgHoldMinutes: 0, cumulativeReturns: [], weekly: { trades: 0, pnl: 0, wins: 0, losses: 0, winRate: 0 },
};

function MiniStat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div>
      <div className="stat-label mb-1">{label}</div>
      <div className="font-mono text-[15px] font-semibold" style={{ color: accent }}>{value}</div>
    </div>
  );
}

function formatHoldTime(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

function CumulativeChart({ data }: { data: number[] }) {
  const max = Math.max(...data.map(Math.abs), 1);
  const w = 100;
  const h = 40;
  const step = w / (data.length - 1);
  const mid = h / 2;
  const points = data.map((v, i) => `${(i * step).toFixed(1)},${(mid - (v / max) * (h / 2 - 2)).toFixed(1)}`).join(' ');
  const lastVal = data[data.length - 1];
  const color = lastVal >= 0 ? 'var(--ok)' : 'var(--bad)';
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ height: 120 }} preserveAspectRatio="none">
      <line x1="0" y1={mid} x2={w} y2={mid} stroke="var(--border)" strokeWidth="0.3" />
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StatCard({
  label, value, sub, accent,
}: { label: string; value: string | null; sub?: string; accent?: string }) {
  return (
    <div className="panel">
      <div className="stat-label mb-2">{label}</div>
      {value === null ? (
        <Skeleton w="70%" h={28} />
      ) : (
        <div className="stat-value fade-in" style={{ color: accent }}>{value}</div>
      )}
      {sub && <div className="text-[11px] text-[color:var(--text-3)] mt-1">{sub}</div>}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="stat-label font-medium pb-3 pr-4 whitespace-nowrap">{children}</th>;
}

function fmtUsd(n: number): string {
  const sign = n < 0 ? '-' : n > 0 ? '+' : '';
  return `${sign}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}
