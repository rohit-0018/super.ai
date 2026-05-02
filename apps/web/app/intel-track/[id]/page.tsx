'use client';
import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useApi } from '../../../lib/useApi';
import { Skeleton } from '../../../components/ui/Skeleton';
import { fmtUsdCompact, fmtPriceUsd } from '../../../lib/format-price';

interface Tick {
  ts: string;
  priceUsd: number;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
}

interface Detail {
  id: string;
  chain: string;
  address: string;
  symbol: string | null;
  name: string | null;
  capturedAt: string;
  source: string;
  profileKey: string | null;
  priceUsdAtCapture: number;
  marketCapUsdAtCapture: number | null;
  liquidityUsdAtCapture: number | null;
  pumpedHigh: number | null;
  pumpedHighAt: string | null;
  drawdownLow: number | null;
  drawdownLowAt: string | null;
  currentMcapUsd: number | null;
  currentPriceUsd: number | null;
  rescanCount: number;
  status: string;
  aiScore: number | null;
  aiVerdict: string | null;
  aiSummary: string | null;
  killTriggered: boolean;
  reportJson: any;
  reappearedAt: string | null;
  reappearedSource: string | null;
  peakDeltaPct: number | null;
  currentDeltaPct: number | null;
  ticks: Tick[];
}

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

export default function IntelTrackDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = String(params?.id ?? '');
  const { data, loading } = useApi<Detail>(`/intel-track/${id}`);
  const [stake, setStake] = useState<number>(1000);

  if (loading || !data) {
    return (
      <div className="page space-y-4">
        <Skeleton h={28} w={200} />
        <Skeleton h={120} rounded="md" />
        <Skeleton h={200} rounded="md" />
      </div>
    );
  }

  const peakPct = data.peakDeltaPct ?? 0;
  const projection = stake * (1 + peakPct / 100);
  const ticks = data.ticks ?? [];
  const bestEntry = ticks.reduce<Tick | null>((acc, t) => {
    if (!acc) return t;
    return (t.marketCapUsd ?? Infinity) < (acc.marketCapUsd ?? Infinity) ? t : acc;
  }, null);

  return (
    <div className="page space-y-4">
      <button
        type="button"
        onClick={() => router.back()}
        className="btn btn-sm btn-ghost"
        style={{ alignSelf: 'flex-start', fontSize: 11 }}
      >
        ← Back
      </button>

      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            {data.source} · captured {relTime(data.capturedAt)}
          </div>
          <h1 className="page-title" style={{ fontSize: 28 }}>
            {data.status === 'graduated' && '🚀 '}{data.symbol ?? data.address.slice(0, 8)}
          </h1>
          {data.name && data.name !== data.symbol && (
            <div style={{ fontSize: 13, color: 'var(--text-2)' }}>{data.name}</div>
          )}
          <div className="font-mono" style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
            {data.chain} · {data.address}
          </div>
        </div>

        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Peak delta
          </div>
          <div style={{
            fontSize: 36, fontWeight: 700,
            color: peakPct >= 0 ? 'var(--ok)' : 'var(--bad)',
          }}>
            {peakPct >= 0 ? '+' : ''}{peakPct.toFixed(0)}%
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
            {fmtUsdCompact(data.marketCapUsdAtCapture)} → {fmtUsdCompact(data.pumpedHigh)}
          </div>
        </div>
      </header>

      {/* "If you'd put $X" widget */}
      <section className="section" style={{ padding: '14px 18px' }}>
        <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
          If you'd entered when we called it…
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }}>
          <div style={{ display: 'flex', gap: 4 }}>
            {[100, 500, 1000, 5000, 10_000].map((amt) => (
              <button
                key={amt}
                type="button"
                onClick={() => setStake(amt)}
                className="chip"
                style={{
                  cursor: 'pointer',
                  background: stake === amt ? 'color-mix(in srgb, var(--accent) 22%, transparent)' : 'var(--surface-2)',
                  borderColor: stake === amt ? 'var(--accent)' : 'var(--border)',
                  fontSize: 11,
                }}
              >
                ${amt.toLocaleString()}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 13 }}>
            <span style={{ color: 'var(--text-3)' }}>${stake.toLocaleString()} → </span>
            <span style={{ fontWeight: 700, color: peakPct >= 0 ? 'var(--ok)' : 'var(--bad)' }}>
              ${projection.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </span>
          </div>
        </div>
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
        <Box label="Entry" value={fmtUsdCompact(data.marketCapUsdAtCapture)}
             sub={`@ ${fmtPriceUsd(data.priceUsdAtCapture)}`} />
        <Box label="Peak"
             value={fmtUsdCompact(data.pumpedHigh)}
             sub={data.pumpedHighAt ? relTime(data.pumpedHighAt) : ''}
             delta={data.peakDeltaPct} />
        <Box label="Now"
             value={fmtUsdCompact(data.currentMcapUsd)}
             sub={`@ ${fmtPriceUsd(data.currentPriceUsd)}`}
             delta={data.currentDeltaPct} />
        <Box label="Drawdown low"
             value={fmtUsdCompact(data.drawdownLow)}
             sub={data.drawdownLowAt ? relTime(data.drawdownLowAt) : ''} />
      </div>

      {bestEntry && bestEntry.marketCapUsd && (
        <section className="section" style={{ padding: '12px 16px' }}>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 4 }}>
            Best entry window
          </div>
          <div style={{ fontSize: 13 }}>
            <span style={{ fontWeight: 700, color: 'var(--ok)' }}>{fmtUsdCompact(bestEntry.marketCapUsd)}</span>
            <span style={{ color: 'var(--text-3)' }}> at {relTime(bestEntry.ts)}</span>
            {data.pumpedHigh && (
              <span style={{ marginLeft: 8 }}>
                — would have peaked at +{(((data.pumpedHigh / bestEntry.marketCapUsd) - 1) * 100).toFixed(0)}%
              </span>
            )}
          </div>
        </section>
      )}

      {data.aiSummary && (
        <section className="section" style={{ padding: '14px 18px' }}>
          <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
            What we said {relTime(data.capturedAt)}
          </div>
          <div style={{ fontSize: 13 }}>
            <span className="chip" style={{ marginRight: 8, fontSize: 10 }}>{data.aiVerdict}</span>
            <span style={{ color: 'var(--text-3)' }}>AI {data.aiScore}/100</span>
          </div>
          <p style={{ marginTop: 8, fontSize: 13, color: 'var(--text-2)' }}>{data.aiSummary}</p>
        </section>
      )}

      {data.reappearedAt && (
        <section className="section" style={{ padding: '12px 16px', background: 'color-mix(in srgb, var(--accent) 8%, var(--surface-1))' }}>
          ↺ Re-appeared {relTime(data.reappearedAt)} via <strong>{data.reappearedSource}</strong>
        </section>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <Link href={`/intel?address=${data.address}`} className="btn btn-primary" style={{ fontSize: 12 }}>
          Re-analyze fresh
        </Link>
        <a
          href={`https://dexscreener.com/${data.chain.toLowerCase() === 'solana' ? 'solana' : 'ethereum'}/${data.address}`}
          target="_blank" rel="noopener" className="btn btn-ghost" style={{ fontSize: 12 }}
        >
          Chart ↗
        </a>
      </div>
    </div>
  );
}

function Box({ label, value, sub, delta }: { label: string; value: string; sub?: string; delta?: number | null }) {
  const color = delta == null ? 'var(--text-1)' : delta >= 0 ? 'var(--ok)' : 'var(--bad)';
  return (
    <div className="section" style={{ padding: 12 }}>
      <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        {label}
      </div>
      <div className="font-mono" style={{ fontSize: 16, fontWeight: 700, color, marginTop: 4 }}>
        {value}
      </div>
      {delta != null && (
        <div style={{ fontSize: 11, fontWeight: 600, color, marginTop: 2 }}>
          {delta >= 0 ? '+' : ''}{delta.toFixed(1)}%
        </div>
      )}
      {sub && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}
