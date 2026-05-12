'use client';
import { Suspense, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useApi } from '../../../lib/useApi';
import { Skeleton } from '../../../components/ui/Skeleton';
import { fmtUsdCompact, fmtPriceUsd } from '../../../lib/format-price';
import { BullBearIndicator, VERDICT_COLOR, VERDICT_LABEL } from '../../../components/TokenCard';

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

function IntelTrackDetailInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const id = searchParams?.get('id') ?? '';
  const { data, loading } = useApi<Detail>(id ? `/intel-track/${id}` : '', { enabled: !!id });
  const [stake, setStake] = useState<number>(1000);

  if (!id) {
    return (
      <div className="page">
        <p className="text-[14px]" style={{ color: 'var(--text-2)' }}>
          Missing snapshot id. <Link href="/intel-track" style={{ color: 'var(--accent)' }}>Back to track record</Link>.
        </p>
      </div>
    );
  }

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

      {/* ── Quick Analysis card ── */}
      {data.aiVerdict && (() => {
        const vColor = VERDICT_COLOR[data.aiVerdict] ?? 'var(--accent)';
        return (
          <section style={{
            background: `color-mix(in srgb, ${vColor} 7%, var(--surface))`,
            border: `1px solid color-mix(in srgb, ${vColor} 38%, var(--border))`,
            borderRadius: 12,
            boxShadow: 'inset 0 1px 0 var(--highlight)',
            overflow: 'hidden',
          }}>
            {/* Score + verdict + bull/bear */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px' }}>
              <div style={{
                width: 52, height: 52, borderRadius: '50%', flexShrink: 0,
                border: `2.5px solid ${vColor}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: `color-mix(in srgb, ${vColor} 12%, transparent)`,
              }}>
                <span style={{
                  fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 900,
                  color: vColor, lineHeight: 1,
                }}>
                  {data.aiScore ?? '?'}
                </span>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3, flexWrap: 'wrap' }}>
                  <span style={{
                    fontFamily: 'var(--font-mono)', fontSize: 18, fontWeight: 900,
                    color: vColor, lineHeight: 1,
                  }}>
                    {VERDICT_LABEL[data.aiVerdict] ?? data.aiVerdict}
                  </span>
                  <BullBearIndicator verdict={data.aiVerdict} score={data.aiScore} size="md" />
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-3)' }}>
                  Called {relTime(data.capturedAt)} · {data.source}
                </div>
              </div>
            </div>
            {/* Summary */}
            {data.aiSummary && (
              <div style={{
                padding: '10px 18px 14px',
                borderTop: `1px solid color-mix(in srgb, ${vColor} 14%, var(--border))`,
              }}>
                <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-2)', margin: 0, lineHeight: 1.65 }}>
                  {data.aiSummary}
                </p>
              </div>
            )}
          </section>
        );
      })()}

      <ScoringBreakdownCard address={data.address} symbol={data.symbol ?? '?'} />

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

// ── Scoring breakdown card ────────────────────────────────────────────────

interface ScoreSignal {
  category: 'price' | 'volume' | 'liquidity' | 'age' | 'tape' | 'bonding' | 'community' | 'twitter' | 'dampener' | 'dead-bag';
  label: string;
  delta: number;
  kind: 'add' | 'sub' | 'damp';
}
interface ScoreSnapshot {
  found: boolean;
  address?: string;
  symbol?: string;
  profileKey?: string;
  source?: string;
  scannedAt?: string;
  score?: number;
  verdict?: string;
  summary?: string;
  breakdown?: ScoreSignal[];
}

const CATEGORY_META: Record<ScoreSignal['category'], { label: string; color: string }> = {
  price:     { label: 'Price action',     color: '#22c55e' },
  volume:    { label: 'Volume',           color: '#06b6d4' },
  liquidity: { label: 'Liquidity',        color: '#8b5cf6' },
  age:       { label: 'Age / freshness',  color: '#f59e0b' },
  tape:      { label: 'Tape quality',     color: '#0ea5e9' },
  bonding:   { label: 'Pump.fun curve',   color: '#ec4899' },
  community: { label: 'Community heat',   color: '#f97316' },
  twitter:   { label: 'Twitter / X',      color: '#1d9bf0' },
  dampener:  { label: 'Dampener',         color: '#ef4444' },
  'dead-bag':{ label: 'Dead-bag',         color: '#ef4444' },
};

function ScoringBreakdownCard({ address, symbol }: { address: string; symbol: string }) {
  const { data, loading } = useApi<ScoreSnapshot>(`/hot-tokens/score/${address}`, { ttlMs: 30_000 });

  if (loading) return <Skeleton h={120} rounded="md" />;
  if (!data?.found) return null;

  const sig = data.breakdown ?? [];
  // Group breakdown by category for display
  const byCat = new Map<ScoreSignal['category'], ScoreSignal[]>();
  for (const s of sig) {
    const k = s.category;
    const list = byCat.get(k) ?? [];
    list.push(s);
    byCat.set(k, list);
  }

  const vColor = data.verdict ? (VERDICT_COLOR[data.verdict] ?? 'var(--accent)') : 'var(--accent)';
  const totalAdd = sig.filter((s) => s.kind === 'add').reduce((a, s) => a + s.delta, 0);
  const totalSub = sig.filter((s) => s.kind === 'sub').reduce((a, s) => a + s.delta, 0);
  const hasDamp = sig.some((s) => s.kind === 'damp');

  return (
    <section style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 12,
      overflow: 'hidden',
    }}>
      <header style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '12px 16px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--surface-2)',
      }}>
        <div style={{
          width: 44, height: 44, borderRadius: '50%', flexShrink: 0,
          border: `2px solid ${vColor}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: `color-mix(in srgb, ${vColor} 12%, transparent)`,
          fontFamily: 'var(--font-mono)', fontWeight: 900, fontSize: 14,
          color: vColor,
        }}>{data.score ?? '?'}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-1)' }}>
            Why ${symbol} scored {data.score} <span style={{ color: 'var(--text-3)', fontWeight: 500 }}>· heuristic ({data.profileKey})</span>
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>
            {data.summary} · scanned {data.scannedAt ? relTime(data.scannedAt) : '?'}
          </div>
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-3)', textAlign: 'right' }}>
          <div><span style={{ color: 'var(--ok)' }}>+{totalAdd}</span> / <span style={{ color: 'var(--bad)' }}>{totalSub}</span></div>
          {hasDamp && <div style={{ color: 'var(--bad)' }}>× dampened</div>}
        </div>
      </header>
      <div style={{ padding: '10px 16px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {[...byCat.entries()].map(([cat, items]) => {
          const meta = CATEGORY_META[cat];
          const catTotal = items.reduce((a, s) => a + s.delta, 0);
          return (
            <div key={cat} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12 }}>
              <span style={{
                fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
                letterSpacing: 0.5, color: meta.color, minWidth: 110,
              }}>{meta.label}</span>
              <span style={{
                fontFamily: 'var(--font-mono)',
                color: catTotal >= 0 ? 'var(--ok)' : 'var(--bad)',
                fontWeight: 700, minWidth: 36,
              }}>{catTotal >= 0 ? '+' : ''}{catTotal}</span>
              <span style={{ color: 'var(--text-2)', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {items.map((s, i) => (
                  <span key={i} style={{
                    padding: '1px 6px',
                    borderRadius: 4,
                    background: s.kind === 'damp'
                      ? 'color-mix(in srgb, var(--bad) 18%, transparent)'
                      : s.kind === 'sub'
                      ? 'color-mix(in srgb, var(--bad) 10%, transparent)'
                      : 'color-mix(in srgb, var(--ok) 10%, transparent)',
                    fontSize: 11,
                    border: `1px solid color-mix(in srgb, ${meta.color} 25%, transparent)`,
                  }}>
                    {s.label || '—'}{' '}
                    <span style={{ fontFamily: 'var(--font-mono)', opacity: 0.75 }}>
                      {s.kind === 'damp' ? '×' : (s.delta >= 0 ? `+${s.delta}` : s.delta)}
                    </span>
                  </span>
                ))}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default function IntelTrackDetailPage() {
  return (
    <Suspense
      fallback={
        <div className="page space-y-4">
          <Skeleton h={28} w={200} />
          <Skeleton h={120} rounded="md" />
          <Skeleton h={200} rounded="md" />
        </div>
      }
    >
      <IntelTrackDetailInner />
    </Suspense>
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
