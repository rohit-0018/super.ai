'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { useRealtime } from '../../lib/useRealtime';
import { Skeleton } from '../../components/ui/Skeleton';
import { fmtUsdCompact } from '../../lib/format-price';
import { SignalResult } from '../../components/SignalBanner';
import { useTokenPool } from '../../lib/TokenPoolContext';

function CopyCA({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const short = `${address.slice(0, 4)}…${address.slice(-4)}`;
  return (
    <span
      title={address}
      onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(address).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
      style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: copied ? 'var(--ok)' : 'var(--text-3)', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 3, padding: '1px 5px', cursor: 'pointer', display: 'inline-block', marginTop: 3, userSelect: 'none' }}
    >
      {copied ? '✓ copied' : short}
    </span>
  );
}

/* ── Types ─────────────────────────────────────────────────────── */
type Source = 'hot_tokens_scan' | 'manual_scan' | 'telegram_scan' | 'snipe';
type Status = 'active' | 'retired' | 'rugged' | 'graduated';

interface FeedItem {
  id: string;
  chain: string;
  address: string;
  symbol: string | null;
  name: string | null;
  capturedAt: string;
  source: Source;
  profileKey: string | null;
  marketCapUsdAtCapture: number | null;
  pumpedHigh: number | null;
  currentMcapUsd: number | null;
  status: Status;
  aiScore: number | null;
  aiVerdict: string | null;
  sparkline: number[];
  peakDeltaPct: number | null;
  currentDeltaPct: number | null;
  // Local UI flag set when this item arrived live via WS
  _isFresh?: boolean;
}

interface CaptureEvent {
  id: string;
  source: Source;
  symbol: string | null;
  address: string;
  chain: string;
  ts: string;
}

/** Extra signal data stored per address from the signal_analysis WS event */
interface SignalExtra {
  t1Pct?: number;
  t2Pct?: number;
  stopLossPct?: number;
  riskReward?: number;
  aiSummary?: string;
  holdRange?: string;
}

const SOURCE_LABEL: Record<Source, string> = {
  hot_tokens_scan: '🔥 Hot scan',
  manual_scan: '🔍 Manual',
  telegram_scan: '📱 Telegram',
  snipe: '🎯 Snipe',
};

const SOURCE_TONE: Record<Source, string> = {
  hot_tokens_scan: '#f59e0b',
  manual_scan: '#a855f7',
  telegram_scan: '#3b82f6',
  snipe: '#22c55e',
};

const STATUS_TONE: Record<Status, string> = {
  active: 'var(--accent)',
  graduated: 'var(--ok)',
  retired: 'var(--text-3)',
  rugged: 'var(--bad)',
};

const VERDICT_COLOR: Record<string, string> = {
  STRONG_BUY: '#22c55e',
  BUY:        '#4ade80',
  CAUTIOUS:   '#f59e0b',
  SKIP:       '#8a8fa3',
  HIGH_RISK:  '#ef4444',
};

const VERDICT_LABEL: Record<string, string> = {
  STRONG_BUY: '🔥 STRONG BUY',
  BUY:        '✅ BUY',
  CAUTIOUS:   '⚠ CAUTIOUS',
  HIGH_RISK:  '🛑 HIGH RISK',
  SKIP:       '— SKIP',
};

const FEED_MAX = 100;          // cap to avoid DOM bloat
const FRESH_FLASH_MS = 6_000;  // how long a new card stays highlighted

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 5_000) return 'just now';
  if (ms < 60_000) return `${Math.floor(ms / 1_000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

/** Returns sort group 0 (best) … 4 (worst) based on verdict/score */
function verdictGroup(item: FeedItem): number {
  if (item.aiVerdict === null) return 3;
  if (item.aiVerdict === 'HIGH_RISK' || item.aiVerdict === 'SKIP') return 4;
  const score = item.aiScore ?? 0;
  if (score >= 78) return 0;
  if (score >= 62) return 1;
  return 2;
}

/* ── Page ──────────────────────────────────────────────────────── */
export default function HotFeedPage() {
  // Initial backfill — last 60 captures, no minDelta so we see everything fresh.
  const { data: initial, loading } = useApi<FeedItem[]>(
    '/intel-track?status=active,graduated,retired,rugged&minDelta=0&take=60&sort=recent',
    { ttlMs: 30_000 },
  );

  const [items, setItems] = useState<FeedItem[]>([]);
  const [signalExtras, setSignalExtras] = useState<Record<string, SignalExtra>>({});
  const [pulseCount, setPulseCount] = useState(0);
  const seenIds = useRef<Set<string>>(new Set());
  const liveCount = useRef(0);

  // Hydrate from initial fetch (only once per server-data change)
  useEffect(() => {
    if (Array.isArray(initial) && items.length === 0) {
      setItems(initial);
      seenIds.current = new Set(initial.map((i) => i.id));
    }
  }, [initial, items.length]);

  // Live: prepend new captures as they land.
  const onCapture = useCallback(async (evt: CaptureEvent) => {
    if (!evt?.id || seenIds.current.has(evt.id)) return;
    seenIds.current.add(evt.id);
    liveCount.current += 1;
    setPulseCount((p) => p + 1);

    // Fetch the full row so we have all card fields. Cheap (one row).
    let full: FeedItem | null = null;
    try {
      const res = await api.get<FeedItem>(`/intel-track/${evt.id}`);
      full = res?.data ?? null;
    } catch { /* ignore */ }

    const stub: FeedItem = full ?? {
      id: evt.id,
      chain: evt.chain,
      address: evt.address,
      symbol: evt.symbol,
      name: null,
      capturedAt: evt.ts,
      source: evt.source,
      profileKey: null,
      marketCapUsdAtCapture: null,
      pumpedHigh: null,
      currentMcapUsd: null,
      status: 'active',
      aiScore: null,
      aiVerdict: null,
      sparkline: [],
      peakDeltaPct: null,
      currentDeltaPct: null,
    };
    stub._isFresh = true;

    setItems((prev) => {
      const next = [stub, ...prev.filter((i) => i.id !== stub.id)];
      return next.slice(0, FEED_MAX);
    });

    // Drop the fresh flag after FRESH_FLASH_MS so it stops glowing.
    setTimeout(() => {
      setItems((prev) => prev.map((i) => i.id === stub.id ? { ...i, _isFresh: false } : i));
    }, FRESH_FLASH_MS);
  }, []);

  useRealtime('intel_capture_new', onCapture);

  // Live: update AI score/verdict when signal_analysis arrives
  const onSignalAnalysis = useCallback((result: SignalResult) => {
    if (!result?.address) return;

    // Update the matching FeedItem with the score and verdict
    setItems((prev) =>
      prev.map((item) =>
        item.address === result.address
          ? { ...item, aiScore: result.score, aiVerdict: result.verdict }
          : item,
      ),
    );

    // Store extra signal data keyed by address
    setSignalExtras((prev) => ({
      ...prev,
      [result.address]: {
        t1Pct:       result.t1Pct,
        t2Pct:       result.t2Pct,
        stopLossPct: result.stopLossPct,
        riskReward:  result.riskReward,
        aiSummary:   result.aiSummary,
        holdRange:   result.holdRange,
      },
    }));
  }, []);

  useRealtime('signal_analysis', onSignalAnalysis);

  // Sort items by verdict group, then score desc, then capturedAt desc.
  // Fresh items always float to the absolute top.
  const sortedItems = useMemo(() => {
    const fresh = items.filter((i) => i._isFresh);
    const rest  = items.filter((i) => !i._isFresh);
    rest.sort((a, b) => {
      const ga = verdictGroup(a);
      const gb = verdictGroup(b);
      if (ga !== gb) return ga - gb;
      const sa = a.aiScore ?? -1;
      const sb = b.aiScore ?? -1;
      if (sa !== sb) return sb - sa;
      return new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime();
    });
    return [...fresh, ...rest];
  }, [items]);

  // Derive section groups for headers (ignoring fresh — they float above)
  const nonFreshItems = sortedItems.filter((i) => !i._isFresh);
  const hasStrongBuy = nonFreshItems.some((i) => verdictGroup(i) === 0);
  const hasBuy       = nonFreshItems.some((i) => verdictGroup(i) === 1);
  const hasOthers    = nonFreshItems.some((i) => verdictGroup(i) >= 2);

  return (
    <div className="page space-y-4">
      <header className="page-header">
        <div>
          <div className="section-eyebrow">Live Stream</div>
          <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            🔥 Hot Feed
            <span className="chip" style={{
              background: 'color-mix(in srgb, var(--accent) 18%, transparent)',
              borderColor: 'var(--accent)',
              fontSize: 10, fontWeight: 600,
            }}>
              <span className="live-dot" style={{ marginRight: 4 }} />
              live
            </span>
          </h1>
          <p className="page-subtitle">
            Every token analysed by the bot streams in here in real time. Matures with proven peak delta →
            graduates to <Link href="/intel-track" style={{ color: 'var(--accent)' }}>Intel Track</Link>.
          </p>
        </div>
        <div className="section-actions">
          <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>
            {liveCount.current > 0 ? `${liveCount.current} new live` : `${items.length} cards`}
          </span>
        </div>
      </header>

      {loading && items.length === 0 ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
          {[...Array(8)].map((_, i) => <Skeleton key={i} h={180} rounded="md" />)}
        </div>
      ) : items.length === 0 ? (
        <div className="panel" style={{ padding: 32, textAlign: 'center' }}>
          <div style={{ fontSize: 32, marginBottom: 10, opacity: 0.4 }}>📡</div>
          <p className="text-[14px]" style={{ color: 'var(--text-2)' }}>Listening for captures…</p>
          <p className="text-[12px] mt-2" style={{ color: 'var(--text-3)' }}>
            Cards will stream in as the bot scans tokens.
          </p>
        </div>
      ) : (
        <div className="hot-feed-stack">
          {/* Fresh items — always at top, no section header */}
          {sortedItems.filter((i) => i._isFresh).map((s) => (
            <FeedCard key={s.id} s={s} extra={signalExtras[s.address]} />
          ))}

          {/* Strong Buy section */}
          {hasStrongBuy && (
            <>
              <SectionHeader label="🔥 Strong Buy" color="#22c55e" />
              {nonFreshItems.filter((i) => verdictGroup(i) === 0).map((s) => (
                <FeedCard key={s.id} s={s} extra={signalExtras[s.address]} />
              ))}
            </>
          )}

          {/* Buy section */}
          {hasBuy && (
            <>
              <SectionHeader label="✅ Buy Signals" color="#4ade80" />
              {nonFreshItems.filter((i) => verdictGroup(i) === 1).map((s) => (
                <FeedCard key={s.id} s={s} extra={signalExtras[s.address]} />
              ))}
            </>
          )}

          {/* Others section (groups 2, 3, 4) */}
          {hasOthers && (
            <>
              <SectionHeader label="📊 Others" color="var(--text-3)" />
              {nonFreshItems.filter((i) => verdictGroup(i) >= 2).map((s) => (
                <FeedCard key={s.id} s={s} extra={signalExtras[s.address]} />
              ))}
            </>
          )}
        </div>
      )}

      {/* Animation styles. Keep them scoped to the page to avoid leaks. */}
      <style jsx>{`
        .hot-feed-stack {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
          gap: 12px;
        }
        /* Section headers span the full grid width */
        .hot-feed-section-header {
          grid-column: 1 / -1;
        }
        @keyframes feed-card-in {
          from {
            opacity: 0;
            transform: translateY(-14px) scale(0.97);
            filter: blur(2px);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
            filter: blur(0);
          }
        }
        @keyframes feed-card-pulse {
          0%, 100% {
            box-shadow:
              0 0 0 0 color-mix(in srgb, var(--accent) 30%, transparent),
              0 8px 28px -10px rgba(0, 0, 0, 0.5);
          }
          50% {
            box-shadow:
              0 0 0 6px color-mix(in srgb, var(--accent) 0%, transparent),
              0 8px 28px -10px rgba(0, 0, 0, 0.5);
          }
        }
        @keyframes analyzing-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

/* ── Section Header ─────────────────────────────────────────────── */
function SectionHeader({ label, color }: { label: string; color: string }) {
  return (
    <div
      className="hot-feed-section-header"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 0 2px',
      }}
    >
      <span style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color,
      }}>
        {label}
      </span>
      <div style={{ flex: 1, height: 1, background: `color-mix(in srgb, ${color} 25%, var(--border))` }} />
    </div>
  );
}

/* ── Card ──────────────────────────────────────────────────────── */
function FeedCard({ s, extra }: { s: FeedItem; extra?: SignalExtra }) {
  const pool = useTokenPool();
  const live = pool[s.address];

  // Prefer pool live data; fall back to DB snapshot values
  const currentMcap = live?.marketCapUsd ?? s.currentMcapUsd;
  const currentDelta =
    live && s.marketCapUsdAtCapture
      ? ((live.marketCapUsd - s.marketCapUsdAtCapture) / s.marketCapUsdAtCapture) * 100
      : s.currentDeltaPct;

  const tone = SOURCE_TONE[s.source] ?? 'var(--accent)';
  const statusTone = STATUS_TONE[s.status] ?? 'var(--text-3)';
  const peak = s.peakDeltaPct;
  const peakColor = peak == null ? 'var(--text-3)' : peak >= 50 ? 'var(--ok)' : peak >= 5 ? 'var(--accent)' : 'var(--text-3)';

  const verdictColor = s.aiVerdict ? (VERDICT_COLOR[s.aiVerdict] ?? 'var(--text-3)') : undefined;
  const analyzed = s.aiVerdict != null;

  const tickRef = useRef<HTMLSpanElement>(null);
  const lastCurrent = useRef<number | null>(currentMcap);
  // Flash "Now" value when pool pushes a fresher price
  useEffect(() => {
    if (currentMcap == null || lastCurrent.current === currentMcap) return;
    const node = tickRef.current;
    lastCurrent.current = currentMcap;
    if (!node) return;
    node.style.transition = 'none';
    node.style.color = 'var(--accent)';
    requestAnimationFrame(() => {
      node.style.transition = 'color 800ms ease';
      node.style.color = '';
    });
  }, [currentMcap]);

  return (
    <Link
      href={`/intel-track/detail?id=${s.id}`}
      style={{
        textDecoration: 'none', color: 'inherit',
        position: 'relative',
        border: analyzed && verdictColor
          ? `1px solid color-mix(in srgb, ${verdictColor} 45%, var(--border))`
          : '1px solid var(--border)',
        borderRadius: 12,
        padding: '14px 16px',
        background: analyzed && verdictColor
          ? `
            radial-gradient(circle at 0% 0%, color-mix(in srgb, ${verdictColor} 10%, transparent) 0%, transparent 55%),
            var(--surface-1)
          `
          : `
            radial-gradient(circle at 0% 0%, color-mix(in srgb, ${tone} 14%, transparent) 0%, transparent 55%),
            var(--surface-1)
          `,
        display: 'flex', flexDirection: 'column', gap: 10,
        animation: s._isFresh
          ? 'feed-card-in 360ms cubic-bezier(0.2, 0.8, 0.2, 1), feed-card-pulse 1.6s ease-in-out 0s 3'
          : 'feed-card-in 280ms cubic-bezier(0.2, 0.8, 0.2, 1)',
        transition: 'transform 0.18s ease, border-color 0.18s ease',
        boxShadow: analyzed && verdictColor
          ? `0 0 18px -6px color-mix(in srgb, ${verdictColor} 30%, transparent)`
          : undefined,
      }}
    >
      {/* Fresh badge */}
      {s._isFresh && !analyzed && (
        <span style={{
          position: 'absolute', top: 8, right: 8,
          fontSize: 9, fontWeight: 700, letterSpacing: '0.08em',
          padding: '2px 6px', borderRadius: 4,
          background: 'var(--accent)', color: 'white',
          textTransform: 'uppercase',
          animation: 'feed-card-in 240ms ease',
        }}>
          NEW
        </span>
      )}

      {/* Analyzing spinner — shown when no verdict yet */}
      {!analyzed && !s._isFresh && (
        <span style={{
          position: 'absolute', top: 8, right: 8,
          fontSize: 9, fontWeight: 600, letterSpacing: '0.06em',
          padding: '2px 7px', borderRadius: 4,
          background: 'color-mix(in srgb, var(--accent) 10%, var(--surface-2))',
          border: '1px solid color-mix(in srgb, var(--accent) 25%, var(--border))',
          color: 'var(--text-3)',
          display: 'flex', alignItems: 'center', gap: 4,
        }}>
          <span style={{ display: 'inline-block', animation: 'analyzing-spin 1.2s linear infinite' }}>⏳</span>
          Analyzing…
        </span>
      )}

      {/* AI Verdict overlay — shown when analysis is available */}
      {analyzed && verdictColor && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: `color-mix(in srgb, ${verdictColor} 12%, var(--surface-2))`,
          border: `1px solid color-mix(in srgb, ${verdictColor} 35%, var(--border))`,
          borderRadius: 8,
          padding: '6px 10px',
          gap: 8,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span style={{
              fontSize: 11, fontWeight: 700, letterSpacing: '0.07em',
              color: verdictColor, textTransform: 'uppercase', whiteSpace: 'nowrap',
            }}>
              {VERDICT_LABEL[s.aiVerdict!] ?? s.aiVerdict}
            </span>
            {s.aiScore != null && (
              <span style={{
                fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 700,
                color: verdictColor,
                textShadow: `0 0 8px color-mix(in srgb, ${verdictColor} 40%, transparent)`,
              }}>
                {s.aiScore}
                <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--text-3)' }}>/100</span>
              </span>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, minWidth: 0 }}>
            {extra?.t1Pct != null && (
              <span style={{ fontSize: 10, color: 'var(--ok)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                → T1 +{extra.t1Pct.toFixed(0)}%
              </span>
            )}
            {extra?.riskReward != null && (
              <span style={{ fontSize: 10, color: 'var(--text-3)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                R:R {extra.riskReward.toFixed(1)}x
              </span>
            )}
          </div>
        </div>
      )}

      {/* AI Summary — truncated 1 line */}
      {analyzed && extra?.aiSummary && (
        <div style={{
          fontSize: 11, color: 'var(--text-2)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          opacity: 0.85,
        }}>
          {extra.aiSummary}
        </div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 16, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {s.status === 'graduated' && '🚀 '}
            {s.symbol ?? s.address.slice(0, 6)}
          </div>
          {s.name && s.name !== s.symbol && (
            <div style={{ fontSize: 11, color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {s.name}
            </div>
          )}
          <CopyCA address={s.address} />
        </div>
        <span className="chip" style={{
          background: `color-mix(in srgb, ${statusTone} 16%, transparent)`,
          borderColor: `color-mix(in srgb, ${statusTone} 40%, var(--border))`,
          color: statusTone, fontSize: 9, fontWeight: 700, textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}>
          {s.status}
        </span>
      </div>

      {/* Metadata */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <span style={{
          fontSize: 10, color: tone, fontWeight: 600,
          background: `color-mix(in srgb, ${tone} 12%, transparent)`,
          padding: '2px 7px', borderRadius: 4,
          border: `1px solid color-mix(in srgb, ${tone} 30%, var(--border))`,
        }}>
          {SOURCE_LABEL[s.source] ?? s.source}
        </span>
        <span style={{ fontSize: 10, color: 'var(--text-3)', padding: '2px 0' }}>
          · {relTime(s.capturedAt)}
        </span>
      </div>

      {/* Three-stat row — "Now" always reads from the shared token pool */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
        <Stat label="Entry" value={fmtUsdCompact(s.marketCapUsdAtCapture)} />
        <Stat label="Peak" value={fmtUsdCompact(s.pumpedHigh)} delta={peak} />
        <Stat
          label="Now"
          value={<span ref={tickRef as any}>{fmtUsdCompact(currentMcap)}</span>}
          delta={currentDelta}
        />
      </div>

      {/* Sparkline */}
      <Sparkline values={s.sparkline ?? []} delta={peak ?? 0} />

      {/* Big peak number — the marketing punch */}
      {peak != null && peak > 0 && (
        <div style={{
          fontSize: 11, color: 'var(--text-3)', display: 'flex',
          justifyContent: 'space-between', alignItems: 'baseline',
        }}>
          <span>peak delta</span>
          <span style={{ fontSize: 18, fontWeight: 700, color: peakColor }}>
            +{peak.toFixed(0)}%
          </span>
        </div>
      )}
    </Link>
  );
}

function Stat({ label, value, delta }: { label: string; value: React.ReactNode; delta?: number | null }) {
  const color = delta == null ? 'var(--text-1)' : delta >= 0 ? 'var(--ok)' : 'var(--bad)';
  return (
    <div>
      <div style={{
        fontSize: 9, color: 'var(--text-3)',
        textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2,
      }}>
        {label}
      </div>
      <div className="font-mono" style={{ fontSize: 12, fontWeight: 700, color }}>
        {value}
      </div>
      {delta != null && (
        <div style={{ fontSize: 10, fontWeight: 600, color, marginTop: 1 }}>
          {delta >= 0 ? '+' : ''}{delta.toFixed(0)}%
        </div>
      )}
    </div>
  );
}

function Sparkline({ values, delta }: { values: number[]; delta: number }) {
  if (!values?.length || values.length < 2) {
    return <div style={{ height: 28, opacity: 0.3, fontSize: 9, color: 'var(--text-3)', textAlign: 'center', paddingTop: 9 }}>
      ── awaiting price ticks ──
    </div>;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const w = 200;
  const h = 28;
  const points = values.map((v, i) => {
    const x = (i / Math.max(values.length - 1, 1)) * w;
    const y = h - ((v - min) / range) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const stroke = delta >= 0 ? 'var(--ok)' : 'var(--bad)';
  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id={`grad-${delta >= 0 ? 'up' : 'down'}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.25" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polyline
        points={`0,${h} ${points} ${w},${h}`}
        fill={`url(#grad-${delta >= 0 ? 'up' : 'down'})`}
        stroke="none"
      />
      <polyline points={points} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
