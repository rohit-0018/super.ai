'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { useRealtime } from '../../lib/useRealtime';
import { Skeleton } from '../../components/ui/Skeleton';
import { SignalResult } from '../../components/SignalBanner';
import { useTokenPool } from '../../lib/TokenPoolContext';
import { TokenCard } from '../../components/TokenCard';

/* ── Types ─────────────────────────────────────────────────────────────────── */
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

interface SignalExtra {
  t1Pct?: number;
  t2Pct?: number;
  stopLossPct?: number;
  riskReward?: number;
  aiSummary?: string;
  holdRange?: string;
}

const FEED_MAX      = 100;
const FRESH_FLASH_MS = 6_000;

/** Live hot-scan shape from /api/hot-tokens — used to render the two top
 *  sections (chain-hot + qwai-curated) above the capture history feed. */
interface HotScanLive {
  tokens: HotScanToken[];
  chainTokens?: HotScanToken[];
  profileKey: string;
  scannedAt: string;
}
interface HotScanToken {
  address: string;
  symbol: string;
  name: string;
  chain: string;
  priceUsd: number;
  priceChange1h: number;
  priceChange5m: number;
  marketCapUsd: number;
  liquidityUsd: number;
  volume24hUsd: number;
  pairAgeHours: number;
  score: number;
  verdict: string;
  summary: string;
  source: string;
  dexUrl?: string;
  buys1h?: number;
  sells1h?: number;
  volume1hUsd?: number;
}

/* ── Page ───────────────────────────────────────────────────────────────────── */
export default function HotFeedPage() {
  const { data: initial, loading } = useApi<FeedItem[]>(
    '/intel-track?status=active,graduated,retired,rugged&minDelta=0&take=60&sort=recent',
    { ttlMs: 30_000 },
  );
  const { data: cachedSignals } = useApi<SignalResult[]>('/hot-tokens/signals', { ttlMs: 60_000 });
  // Live scan data — two distinct rankings of the same enriched candidates.
  // Refreshed every 25s so the top sections feel "live" without hammering API.
  const { data: liveScan } = useApi<HotScanLive>('/hot-tokens?profileKey=meme_hunter', { pollMs: 25_000 });

  const [items, setItems]             = useState<FeedItem[]>([]);
  const [signalExtras, setSignalExtras] = useState<Record<string, SignalExtra>>({});
  const [analysisTriggered, setAnalysisTriggered] = useState(false);
  const [pulseCount, setPulseCount]   = useState(0);
  const seenIds    = useRef<Set<string>>(new Set());
  const liveCount  = useRef(0);
  const enqueuedRef = useRef(false);
  // True when the signal pipeline is server-side disabled. Used to avoid
  // showing an "Analyzing…" spinner that will never resolve.
  const pipelineDisabledRef = useRef(false);

  useEffect(() => {
    if (Array.isArray(initial) && items.length === 0) {
      setItems(initial);
      seenIds.current = new Set(initial.map((i) => i.id));
    }
  }, [initial, items.length]);

  // Hydrate verdict/score from in-memory pipeline results on page load
  useEffect(() => {
    if (!Array.isArray(cachedSignals) || !cachedSignals.length) return;
    const byAddr = new Map(cachedSignals.map((s) => [s.address, s]));
    setItems((prev) =>
      prev.map((item) => {
        if (item.aiVerdict) return item;
        const s = byAddr.get(item.address);
        return s ? { ...item, aiScore: s.score, aiVerdict: s.verdict } : item;
      }),
    );
    setSignalExtras((prev) => {
      const merged = { ...prev };
      for (const s of cachedSignals) {
        if (!merged[s.address]) {
          merged[s.address] = { t1Pct: s.t1Pct, t2Pct: s.t2Pct, stopLossPct: s.stopLossPct, riskReward: s.riskReward, aiSummary: s.aiSummary, holdRange: s.holdRange };
        }
      }
      return merged;
    });
  }, [cachedSignals]);

  // Enqueue unanalyzed cards for AI analysis once initial data loads
  useEffect(() => {
    if (!Array.isArray(initial) || !initial.length || enqueuedRef.current) return;
    enqueuedRef.current = true;
    const toAnalyze = initial
      .filter((i) => !i.aiVerdict)
      .slice(0, 20)
      .map((i) => ({ address: i.address, symbol: i.symbol ?? i.address.slice(0, 6), profileKey: i.profileKey ?? 'meme_hunter' }));
    if (!toAnalyze.length) return;
    api.post<{ queued: number; disabled?: boolean }>('/hot-tokens/signals/analyze', { items: toAnalyze })
      .then((r) => {
        if (r?.data?.disabled) pipelineDisabledRef.current = true;
        else setAnalysisTriggered(true);
      })
      .catch(() => {});
  }, [initial]);

  const onCapture = useCallback(async (evt: CaptureEvent) => {
    if (!evt?.id || seenIds.current.has(evt.id)) return;
    seenIds.current.add(evt.id);
    liveCount.current += 1;
    setPulseCount((p) => p + 1);

    let full: FeedItem | null = null;
    try {
      const res = await api.get<FeedItem>(`/intel-track/${evt.id}`);
      full = res?.data ?? null;
    } catch { /* ignore */ }

    const stub: FeedItem = full ?? {
      id: evt.id, chain: evt.chain, address: evt.address, symbol: evt.symbol,
      name: null, capturedAt: evt.ts, source: evt.source, profileKey: null,
      marketCapUsdAtCapture: null, pumpedHigh: null, currentMcapUsd: null,
      status: 'active', aiScore: null, aiVerdict: null, sparkline: [],
      peakDeltaPct: null, currentDeltaPct: null,
    };
    stub._isFresh = true;

    setItems((prev) => {
      const next = [stub, ...prev.filter((i) => i.id !== stub.id)];
      return next.slice(0, FEED_MAX);
    });

    setTimeout(() => {
      // When the pipeline is server-side disabled, no AI verdict will ever
      // arrive — clear _isFresh entirely so the card doesn't sit in the
      // "Analyzing…" spinner state forever.
      const cleared = pipelineDisabledRef.current ? undefined : false;
      setItems((prev) =>
        prev.map((i) => (i.id === stub.id ? { ...i, _isFresh: cleared } : i)),
      );
    }, FRESH_FLASH_MS);
  }, []);

  useRealtime('intel_capture_new', onCapture);

  const onSignalAnalysis = useCallback((result: SignalResult) => {
    if (!result?.address) return;
    setItems((prev) =>
      prev.map((item) =>
        item.address === result.address
          ? { ...item, aiScore: result.score, aiVerdict: result.verdict }
          : item,
      ),
    );
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

  const sortedItems = useMemo(() => {
    return [...items].sort((a, b) => {
      if (a._isFresh && !b._isFresh) return -1;
      if (!a._isFresh && b._isFresh) return 1;
      return new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime();
    });
  }, [items]);

  return (
    <div className="page space-y-4">
      <header className="page-header">
        <div>
          <div className="section-eyebrow">Live Stream</div>
          <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            🔥 Hot Feed
            <span className="chip" style={{
              background: 'color-mix(in srgb, var(--accent) 18%, transparent)',
              borderColor: 'var(--accent)', fontSize: 10, fontWeight: 600,
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

      <HotScanSection
        title="🔥 Hot on Solana"
        subtitle="Raw on-chain hotness — ranked by volume, source priority, recency. Includes everything the scanner found, no score filter."
        tokens={liveScan?.chainTokens ?? []}
        emptyMsg="Waiting for first scan…"
        updatedAt={liveScan?.scannedAt}
      />
      <HotScanSection
        title="🎯 Curated by QWAI"
        subtitle={`Heuristic score ≥ 60. Filtered by our 25-signal scorer (tape quality, pump.fun lifecycle, Twitter mentions, dampeners).`}
        tokens={liveScan?.tokens ?? []}
        emptyMsg="No tokens crossed the QWAI threshold this scan."
        updatedAt={liveScan?.scannedAt}
      />

      <header className="section-header" style={{ marginTop: 24 }}>
        <div>
          <div className="section-eyebrow">History</div>
          <h2 className="section-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            📜 Captured stream
          </h2>
          <p className="text-[12px]" style={{ color: 'var(--text-3)', marginTop: 2 }}>
            Every token captured by the bot so you can review what triggered + how it played out.
          </p>
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
          {sortedItems.map((s) => (
            <FeedCard key={s.id} s={s} extra={signalExtras[s.address]} pendingAnalysis={analysisTriggered} />
          ))}
        </div>
      )}

      <style jsx>{`
        .hot-feed-stack {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
          gap: 12px;
        }
      `}</style>

      {/* Global so the classnames apply inside child <HotScanCard> too */}
      <style jsx global>{`
        @keyframes hf-flash-up {
          0%   { background-color: color-mix(in srgb, var(--ok) 35%, transparent); }
          100% { background-color: transparent; }
        }
        @keyframes hf-flash-down {
          0%   { background-color: color-mix(in srgb, var(--bad) 35%, transparent); }
          100% { background-color: transparent; }
        }
        .hf-flash-up   { animation: hf-flash-up   600ms ease-out; }
        .hf-flash-down { animation: hf-flash-down 600ms ease-out; }

        @keyframes hf-enter-anim {
          0%   { opacity: 0; transform: translateY(8px); }
          100% { opacity: 1; transform: translateY(0); }
        }
        .hf-enter { animation: hf-enter-anim 350ms ease-out both; }

        @keyframes hf-live-pulse {
          0%, 100% { opacity: 1;   transform: scale(1); }
          50%      { opacity: 0.5; transform: scale(0.85); }
        }
        .hf-live-dot { animation: hf-live-pulse 1.5s ease-in-out infinite; }

        @media (prefers-reduced-motion: reduce) {
          .hf-flash-up, .hf-flash-down, .hf-enter, .hf-live-dot {
            animation: none !important;
          }
        }
      `}</style>
    </div>
  );
}

/* ── FeedCard: thin wrapper that resolves pool data then delegates to TokenCard */
function FeedCard({ s, extra, pendingAnalysis }: { s: FeedItem; extra?: SignalExtra; pendingAnalysis: boolean }) {
  const pool  = useTokenPool();
  const live  = pool[s.address];
  const currentMcap   = live?.marketCapUsd ?? s.currentMcapUsd;
  const currentDelta  =
    live && s.marketCapUsdAtCapture
      ? ((live.marketCapUsd - s.marketCapUsdAtCapture) / s.marketCapUsdAtCapture) * 100
      : s.currentDeltaPct;

  // isFresh logic:
  //   undefined  → historical card, no live-mode badges at all
  //   true       → just arrived via WS (green NEW badge)
  //   false      → awaiting analysis (shows Analyzing… spinner)
  // Only WS-arrived cards (_isFresh set) get the live-mode spinner.
  // DB-loaded historical cards stay undefined — they may not be in the current
  // analysis queue so showing "Analyzing…" on all of them is misleading.
  const isFresh = s._isFresh;

  return (
    <div style={{ position: 'relative' }}>
      <TokenCard
        href={`/intel-track/detail?id=${s.id}`}
        address={s.address}
        symbol={s.symbol}
        name={s.name}
        chain="SOLANA"
        status={s.status}
        source={s.source}
        capturedAt={s.capturedAt}
        profileKey={s.profileKey}
        marketCapAtCapture={s.marketCapUsdAtCapture}
        pumpedHigh={s.pumpedHigh}
        currentMcap={currentMcap}
        peakDelta={s.peakDeltaPct}
        currentDelta={currentDelta}
        sparkline={s.sparkline}
        aiScore={s.aiScore}
        aiVerdict={s.aiVerdict}
        aiSummary={extra?.aiSummary}
        t1Pct={extra?.t1Pct}
        riskReward={extra?.riskReward}
        isFresh={isFresh}
      />
      {/* Floating DexScreener shortcut — never interferes with the card click. */}
      <div style={{ position: 'absolute', top: 6, right: 6, zIndex: 2 }}>
        <DexChartLink address={s.address} chain="SOLANA" />
      </div>
    </div>
  );
}

/* ── Animations ─────────────────────────────────────────────────────────────
 *
 * Trading-app micro-interactions, kept to pure CSS so there's no JS-driven
 * animation cost. Three patterns in play:
 *
 *   useFlash(value)  → returns 'up' | 'down' | null briefly after a numeric
 *                      change. We pin the className onto the element and use
 *                      a keyframe to flash the background.
 *
 *   .hf-enter        → applied to new card entries (first time they appear)
 *                      to slide+fade them in subtly.
 *
 *   .hf-live-dot     → pulsing dot on the section header so users see the
 *                      feed is live even when nothing's moving.
 */
function useFlash(value: number | undefined, durationMs = 600): 'up' | 'down' | null {
  const prev = useRef<number | undefined>(value);
  const [state, setState] = useState<'up' | 'down' | null>(null);
  useEffect(() => {
    if (prev.current === undefined || value === undefined) { prev.current = value; return; }
    if (Math.abs((value ?? 0) - (prev.current ?? 0)) < 0.0001) { prev.current = value; return; }
    const dir = (value ?? 0) > (prev.current ?? 0) ? 'up' : 'down';
    prev.current = value;
    setState(dir);
    const id = setTimeout(() => setState(null), durationMs);
    return () => clearTimeout(id);
  }, [value, durationMs]);
  return state;
}

/* ── HotScanSection: horizontal scroller showing live scan results ─────────── */
function HotScanSection({
  title,
  subtitle,
  tokens,
  emptyMsg,
  updatedAt,
}: {
  title: string;
  subtitle: string;
  tokens: HotScanToken[];
  emptyMsg: string;
  updatedAt?: string;
}) {
  return (
    <section style={{ marginTop: 8 }}>
      <header style={{ marginBottom: 10 }}>
        <h2 className="section-title" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 16 }}>
          {title}
          <span className="chip" style={{ fontSize: 10, color: 'var(--text-3)' }}>
            {tokens.length}
          </span>
          <LivePulse updatedAt={updatedAt} />
        </h2>
        <p className="text-[12px]" style={{ color: 'var(--text-3)', marginTop: 2 }}>{subtitle}</p>
      </header>
      {!tokens.length ? (
        <div className="panel" style={{ padding: '14px 16px', textAlign: 'center' }}>
          <span className="text-[12px]" style={{ color: 'var(--text-3)' }}>{emptyMsg}</span>
        </div>
      ) : (
        // Desktop: fixed-height scrollable multi-col grid (~3 cards visible
        // before scroll). Mobile: shorter container, same scrolling behavior.
        // Compact cards (240px min) so 4-5 fit across a wide monitor.
        <div className="hf-scan-grid" style={{
          maxHeight: 440,
          overflowY: 'auto',
          padding: '4px 2px',
          border: '1px solid var(--border)',
          borderRadius: 8,
          background: 'var(--surface-1)',
        }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
            gap: 8,
            padding: 6,
          }}>
            {tokens.map((t) => <HotScanCard key={t.address} t={t} />)}
          </div>
        </div>
      )}
    </section>
  );
}

/** Pulsing dot + "Updated Ns ago" string that re-renders every second so the
 *  feed feels alive even when the underlying scan hasn't ticked yet. */
function LivePulse({ updatedAt }: { updatedAt?: string }) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const secs = updatedAt
    ? Math.max(0, Math.floor((Date.now() - new Date(updatedAt).getTime()) / 1000))
    : null;
  const fresh = secs != null && secs < 30;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      fontSize: 10, fontWeight: 600, marginLeft: 'auto',
      color: fresh ? 'var(--ok)' : 'var(--text-3)',
    }}>
      <span className="hf-live-dot" style={{
        width: 6, height: 6, borderRadius: '50%',
        background: fresh ? 'var(--ok)' : 'var(--text-3)',
      }} />
      {secs == null ? 'connecting…' : secs < 3 ? 'live' : `${secs}s ago`}
    </span>
  );
}

/** Compact card used in the live-scan sections. Differs from the capture-feed
 *  TokenCard by being lighter (no historical peak data) and always showing
 *  the heuristic score prominently. */
function HotScanCard({ t }: { t: HotScanToken }) {
  const verdictColor =
    t.verdict === 'STRONG_BUY' ? '#22c55e' :
    t.verdict === 'BUY'        ? '#4ade80' :
    t.verdict === 'CAUTIOUS'   ? '#f59e0b' :
    t.verdict === 'SKIP'       ? '#8a8fa3' :
    '#ef4444';
  const scoreFlash = useFlash(t.score);
  const priceFlash = useFlash(t.priceChange1h);
  return (
    <div
      className="panel hf-enter"
      style={{
        padding: '8px 10px',
        color: 'var(--text-1)',
        display: 'flex', flexDirection: 'column', gap: 5,
        border: `1px solid color-mix(in srgb, ${verdictColor} 28%, var(--border))`,
        borderRadius: 8,
        transition: 'border-color 0.15s, background 0.6s ease-out',
        position: 'relative',
      }}
    >
      <Link
        href={`/intel?address=${t.address}`}
        style={{ textDecoration: 'none', color: 'inherit', display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}
      >
        <div
          className={scoreFlash ? `hf-flash-${scoreFlash}` : ''}
          style={{
            width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
            border: `2px solid ${verdictColor}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: `color-mix(in srgb, ${verdictColor} 12%, transparent)`,
            fontFamily: 'var(--font-mono)', fontWeight: 900, fontSize: 11,
            color: verdictColor,
          }}
        >{t.score}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
            <span style={{ fontWeight: 700, fontSize: 13 }}>${t.symbol}</span>
            <span style={{ fontSize: 9, color: verdictColor, fontWeight: 700 }}>{t.verdict}</span>
          </div>
          <div style={{ fontSize: 9, color: 'var(--text-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {t.name}
          </div>
        </div>
      </Link>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, fontSize: 9.5, color: 'var(--text-2)', alignItems: 'center' }}>
        <span>MC ${fmtCompact(t.marketCapUsd)}</span>
        <span
          className={priceFlash ? `hf-flash-${priceFlash}` : ''}
          style={{
            color: t.priceChange1h >= 0 ? 'var(--ok)' : 'var(--bad)',
            padding: '0 4px', borderRadius: 3,
          }}
        >
          {t.priceChange1h >= 0 ? '+' : ''}{t.priceChange1h?.toFixed?.(0) ?? 0}% 1h
        </span>
        <span>{t.pairAgeHours < 1 ? `${(t.pairAgeHours * 60).toFixed(0)}m` : `${t.pairAgeHours.toFixed(0)}h`}</span>
        <DexChartLink address={t.address} chain={t.chain} />
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-2)', fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {t.summary || 'on watch'}
      </div>
    </div>
  );
}

function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return `${n.toFixed(0)}`;
}

/** Small DexScreener "chart" link used on every card. Stops propagation so it
 *  doesn't fire the parent card's navigate-to-analyze link. */
function DexChartLink({ address, chain }: { address: string; chain: string }) {
  const slug = (chain ?? '').toLowerCase() === 'solana' ? 'solana' : 'ethereum';
  return (
    <a
      href={`https://dexscreener.com/${slug}/${address}`}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      title="Open DexScreener chart"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 3,
        padding: '0 5px', height: 16, borderRadius: 3,
        background: 'color-mix(in srgb, var(--accent) 12%, transparent)',
        border: '1px solid color-mix(in srgb, var(--accent) 30%, var(--border))',
        color: 'var(--accent)', fontSize: 9, fontWeight: 700, textDecoration: 'none',
        lineHeight: 1,
      }}
    >
      📈 Dex
    </a>
  );
}
