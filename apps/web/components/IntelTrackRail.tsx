'use client';
import Link from 'next/link';
import { useApi } from '../lib/useApi';
import { fmtUsdCompact } from '../lib/format-price';
import { useTokenPool } from '../lib/TokenPoolContext';

interface RailItem {
  id: string;
  chain: string;
  address: string;
  symbol: string | null;
  capturedAt: string;
  mcapAtCapture: number | null;
  pumpedHigh: number | null;
  currentMcapUsd: number | null;
  deltaPct: number | null;
  sparkline: number[];
  status: string;
}

/**
 * Persistent sidebar rail — appears on every screen. Polls the top track
 * record entries on a 60s interval and renders compact DexScreener-style
 * cards. Click → navigates to /intel-track/:id detail.
 */
export function IntelTrackRail() {
  const { data, loading } = useApi<RailItem[]>('/intel-track/top?limit=5', { pollMs: 60_000 });
  const pool = useTokenPool();
  const items = Array.isArray(data) ? data : [];
  if (!loading && items.length === 0) return null;

  return (
    <aside style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 4px' }} aria-label="Recent intel">
      <div style={{
        fontSize: 10, fontWeight: 600, letterSpacing: '0.1em',
        color: 'var(--text-3)', textTransform: 'uppercase',
        padding: '0 6px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <span>Track Record</span>
        <Link href="/intel-track" style={{ color: 'var(--accent)', textDecoration: 'none', fontSize: 10 }}>
          all →
        </Link>
      </div>

      {items.map((it) => {
        const live = pool[it.address];
        const currentMcap = live?.marketCapUsd ?? it.currentMcapUsd;
        const deltaPct =
          live && it.mcapAtCapture
            ? ((live.marketCapUsd - it.mcapAtCapture) / it.mcapAtCapture) * 100
            : it.deltaPct;
        return (
          <Link
            key={it.id}
            href={`/intel-track/detail?id=${it.id}`}
            style={{
              textDecoration: 'none', color: 'inherit',
              border: '1px solid var(--border)',
              borderRadius: 8, padding: '8px 10px',
              background: 'var(--surface-1)',
              display: 'flex', flexDirection: 'column', gap: 4,
              transition: 'background 0.12s ease',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 700 }}>
                {it.status === 'graduated' ? '🚀 ' : ''}{it.symbol ?? it.address.slice(0, 6)}
              </span>
              <span style={{
                fontSize: 11, fontWeight: 700,
                color: deltaPct == null ? 'var(--text-3)' : deltaPct >= 0 ? 'var(--ok)' : 'var(--bad)',
              }}>
                {deltaPct != null ? `${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(0)}%` : '—'}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 10, color: 'var(--text-3)' }}>
                {fmtUsdCompact(it.mcapAtCapture)} → {fmtUsdCompact(currentMcap)}
              </span>
            </div>
            <Sparkline values={it.sparkline ?? []} delta={deltaPct ?? 0} />
          </Link>
        );
      })}
    </aside>
  );
}

function Sparkline({ values, delta }: { values: number[]; delta: number }) {
  if (!values?.length) return <div style={{ height: 16 }} />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const w = 100;
  const h = 16;
  const points = values.map((v, i) => {
    const x = (i / Math.max(values.length - 1, 1)) * w;
    const y = h - ((v - min) / range) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
      <polyline
        points={points}
        fill="none"
        stroke={delta >= 0 ? 'var(--ok)' : 'var(--bad)'}
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
