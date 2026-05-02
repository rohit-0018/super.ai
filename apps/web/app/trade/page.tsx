'use client';
import { useMemo, useState } from 'react';
import TradingViewChart from '../../components/TradingViewChart';
import SwapForm from '../../components/SwapForm';
import RiskMeter from '../../components/RiskMeter';
import TokenIntelCard from '../../components/TokenIntelCard';
import { Section } from '../../components/ui/Section';
import { useApi, invalidate } from '../../lib/useApi';
import { Skeleton } from '../../components/ui/Skeleton';

type FeedKind = 'manual' | 'agent' | 'snipe' | 'snipe_sell';
type FeedSide = 'buy' | 'sell';
interface FeedItem {
  id: string;
  kind: FeedKind;
  side: FeedSide;
  chain: string;
  mint: string | null;
  tokenIn: string | null;
  tokenOut: string | null;
  amountIn: string | null;
  amountOut: string | null;
  priceUsd: number | null;
  pnlUsd: number | null;
  mode: string;
  txHash: string | null;
  status: string;
  strategyId: string | null;
  sourceMsg: string | null;
  createdAt: string;
}

const KIND_LABEL: Record<FeedKind, string> = {
  manual: 'Manual',
  agent: 'Agent',
  snipe: 'Snipe',
  snipe_sell: 'Snipe sell',
};

const KIND_TONE: Record<FeedKind, string> = {
  manual: 'var(--accent)',
  agent: '#a855f7',
  snipe: '#22c55e',
  snipe_sell: '#f59e0b',
};

function fmtUsd(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(2)}k`;
  if (Math.abs(n) < 0.01 && n !== 0) return `$${n.toExponential(2)}`;
  return `$${n.toFixed(2)}`;
}

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function shortMint(m: string | null): string {
  if (!m) return '—';
  if (m.length <= 14) return m;
  return `${m.slice(0, 6)}…${m.slice(-4)}`;
}

export default function TradePage() {
  const { data: feed, loading } = useApi<FeedItem[]>('/trades/feed');
  const [filter, setFilter] = useState<'all' | FeedKind>('all');
  const [refreshing, setRefreshing] = useState(false);

  const filtered = useMemo(() => {
    if (!Array.isArray(feed)) return [];
    if (filter === 'all') return feed;
    return feed.filter((f) => f.kind === filter);
  }, [feed, filter]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: 0, manual: 0, agent: 0, snipe: 0, snipe_sell: 0 };
    if (Array.isArray(feed)) {
      c.all = feed.length;
      for (const f of feed) c[f.kind] = (c[f.kind] ?? 0) + 1;
    }
    return c;
  }, [feed]);

  const refresh = async () => {
    setRefreshing(true);
    invalidate('/trades/feed');
    await new Promise((r) => setTimeout(r, 500));
    setRefreshing(false);
  };

  return (
    <div className="page page-wide space-y-4">
      <header className="page-header">
        <div>
          <div className="section-eyebrow">Workstation</div>
          <h1 className="page-title">Trade</h1>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="chip"><span className="live-dot" /> Live feed</span>
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing}
            className="btn btn-sm"
            style={{ fontSize: 11, padding: '4px 10px', opacity: refreshing ? 0.6 : 1 }}
          >
            {refreshing ? '⟳ refreshing…' : '↻ Refresh'}
          </button>
        </div>
      </header>

      {/* Chart fills left, right column: swap + risk + intel */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className="xl:col-span-2 min-w-0">
          <Section title="SOL / USDT" subtitle="Binance" flush>
            <TradingViewChart symbol="BINANCE:SOLUSDT" />
          </Section>
        </div>
        <div className="space-y-4 min-w-0">
          <SwapForm />
          <RiskMeter />
          <TokenIntelCard />
        </div>
      </div>

      {/* Unified trade feed: manual + agent + snipe (+ snipe_sell). */}
      <Section
        title="All trades"
        subtitle={loading ? 'loading…' : `${filtered.length} of ${counts.all} shown`}
        flush
        actions={<a href="/analytics" className="btn btn-sm btn-ghost">Open journal →</a>}
      >
        {/* Filter chips — switch between kinds without leaving the page. */}
        <div style={{
          display: 'flex', gap: 6, padding: '10px 14px', flexWrap: 'wrap',
          borderBottom: '1px solid var(--border)',
        }}>
          {(['all', 'manual', 'agent', 'snipe', 'snipe_sell'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setFilter(k)}
              className="chip"
              style={{
                cursor: 'pointer',
                background: filter === k ? 'color-mix(in srgb, var(--accent) 22%, transparent)' : 'var(--surface-2)',
                borderColor: filter === k ? 'var(--accent)' : 'var(--border)',
                fontSize: 11,
              }}
            >
              {k === 'all' ? 'All' : KIND_LABEL[k]} <span style={{ opacity: 0.6, marginLeft: 4 }}>{counts[k] ?? 0}</span>
            </button>
          ))}
        </div>

        <div className="table-scroll">
          {loading ? (
            <div className="space-y-2 p-4">
              {[...Array(5)].map((_, i) => <Skeleton key={i} h={36} rounded="md" />)}
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: '32px 16px', textAlign: 'center' }}>
              <div style={{ fontSize: 32, marginBottom: 8, opacity: 0.4 }}>◎</div>
              <p className="text-[13px]" style={{ color: 'var(--text-2)' }}>
                No trades {filter !== 'all' ? `in ${KIND_LABEL[filter]} category` : 'yet'}.
              </p>
              <p className="text-[11px] mt-1" style={{ color: 'var(--text-3)' }}>
                Snipe a token, run an agent, or place a manual swap to populate this feed.
              </p>
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Side</th>
                  <th>Chain</th>
                  <th>Token</th>
                  <th className="num">Amount in</th>
                  <th className="num">Out</th>
                  <th className="num">Price</th>
                  <th className="num">P&amp;L</th>
                  <th>Status</th>
                  <th>When</th>
                  <th>Tx</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const tone = KIND_TONE[r.kind];
                  const sideColor = r.side === 'sell' ? 'var(--bad)' : 'var(--ok)';
                  const txUrl = r.txHash
                    ? r.chain === 'SOLANA'
                      ? `https://solscan.io/tx/${r.txHash}`
                      : `https://etherscan.io/tx/${r.txHash}`
                    : null;
                  return (
                    <tr key={r.id}>
                      <td>
                        <span className="chip" style={{
                          background: `color-mix(in srgb, ${tone} 18%, transparent)`,
                          borderColor: `color-mix(in srgb, ${tone} 50%, var(--border))`,
                          color: tone, fontSize: 10, fontWeight: 600,
                        }}>{KIND_LABEL[r.kind]}</span>
                      </td>
                      <td><span style={{ color: sideColor, fontWeight: 600, fontSize: 12 }}>{r.side.toUpperCase()}</span></td>
                      <td><span className="chip" style={{ fontSize: 10 }}>{r.chain}</span></td>
                      <td className="font-mono text-[11px]" title={r.mint ?? ''}>{shortMint(r.mint)}</td>
                      <td className="num text-[11px]">{r.amountIn ?? '—'}</td>
                      <td className="num text-[11px]">{r.amountOut ?? '—'}</td>
                      <td className="num text-[12px]">{fmtUsd(r.priceUsd)}</td>
                      <td className="num text-[12px]" style={{ color: r.pnlUsd != null ? (r.pnlUsd >= 0 ? 'var(--ok)' : 'var(--bad)') : 'var(--text-3)' }}>
                        {r.pnlUsd != null ? `${r.pnlUsd >= 0 ? '+' : ''}${fmtUsd(r.pnlUsd)}` : '—'}
                      </td>
                      <td>
                        <span className="chip" style={{
                          fontSize: 10,
                          background: r.status === 'confirmed' ? 'color-mix(in srgb, var(--ok) 18%, transparent)' :
                                       r.status === 'failed' ? 'color-mix(in srgb, var(--bad) 18%, transparent)' :
                                       'var(--surface-2)',
                          color: r.status === 'confirmed' ? 'var(--ok)' :
                                 r.status === 'failed' ? 'var(--bad)' : 'var(--text-2)',
                        }}>{r.status}</span>
                      </td>
                      <td className="text-[11px]" style={{ color: 'var(--text-3)' }}>{relTime(r.createdAt)}</td>
                      <td>{txUrl ? <a href={txUrl} target="_blank" rel="noopener" className="text-[11px]" style={{ color: 'var(--accent)' }}>view ↗</a> : <span style={{ color: 'var(--text-3)', fontSize: 11 }}>—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </Section>
    </div>
  );
}
