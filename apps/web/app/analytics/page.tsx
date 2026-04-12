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
    <div className="space-y-6">
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Analytics</h1>
          <p className="text-[13px] text-[color:var(--text-2)] mt-1">
            Performance, PnL, and trade diagnostics.
          </p>
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
        <div className="panel" style={{ color: 'var(--bad)' }}>
          {error}
        </div>
      )}

      {/* Stats grid */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Total P&L" value={loading ? null : fmtUsd(perf!.totalPnl)} accent={loading ? undefined : (perf!.totalPnl >= 0 ? 'var(--ok)' : 'var(--bad)')} />
        <StatCard label="Win rate" value={loading ? null : `${(perf!.winRate * 100).toFixed(1)}%`} />
        <StatCard label="Trades" value={loading ? null : `${perf!.totalTrades}`} sub={loading ? undefined : `${perf!.wins}W · ${perf!.losses}L`} />
        <StatCard label="Sharpe" value={loading ? null : perf!.sharpe.toFixed(2)} sub={loading ? undefined : 'annualized'} />
      </section>

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
                    <td className="py-3 pr-4 font-mono">{t.amountIn?.toFixed(4) ?? '—'}</td>
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
};

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
