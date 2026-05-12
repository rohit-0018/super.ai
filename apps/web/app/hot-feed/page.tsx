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
      />
      <HotScanSection
        title="🎯 Curated by QWAI"
        subtitle={`Heuristic score ≥ 60. Filtered by our 25-signal scorer (tape quality, pump.fun lifecycle, Twitter mentions, dampeners).`}
        tokens={liveScan?.tokens ?? []}
        emptyMsg="No tokens crossed the QWAI threshold this scan."
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
  );
}

/* ── HotScanSection: horizontal scroller showing live scan results ─────────── */
function HotScanSection({
  title,
  subtitle,
  tokens,
  emptyMsg,
}: {
  title: string;
  subtitle: string;
  tokens: HotScanToken[];
  emptyMsg: string;
}) {
  return (
    <section style={{ marginTop: 8 }}>
      <header style={{ marginBottom: 10 }}>
        <h2 className="section-title" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 16 }}>
          {title}
          <span className="chip" style={{ fontSize: 10, color: 'var(--text-3)' }}>
            {tokens.length}
          </span>
        </h2>
        <p className="text-[12px]" style={{ color: 'var(--text-3)', marginTop: 2 }}>{subtitle}</p>
      </header>
      {!tokens.length ? (
        <div className="panel" style={{ padding: '14px 16px', textAlign: 'center' }}>
          <span className="text-[12px]" style={{ color: 'var(--text-3)' }}>{emptyMsg}</span>
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
          gap: 12,
        }}>
          {tokens.slice(0, 12).map((t) => (
            <HotScanCard key={t.address} t={t} />
          ))}
        </div>
      )}
    </section>
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
  return (
    <Link
      href={`/intel?address=${t.address}`}
      className="panel"
      style={{
        padding: '12px 14px',
        textDecoration: 'none',
        color: 'var(--text-1)',
        display: 'flex', flexDirection: 'column', gap: 8,
        border: `1px solid color-mix(in srgb, ${verdictColor} 30%, var(--border))`,
        transition: 'border-color 0.15s',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{
          width: 38, height: 38, borderRadius: '50%', flexShrink: 0,
          border: `2px solid ${verdictColor}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: `color-mix(in srgb, ${verdictColor} 12%, transparent)`,
          fontFamily: 'var(--font-mono)', fontWeight: 900, fontSize: 13,
          color: verdictColor,
        }}>{t.score}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <span style={{ fontWeight: 700, fontSize: 14 }}>${t.symbol}</span>
            <span style={{ fontSize: 10, color: verdictColor, fontWeight: 700 }}>{t.verdict}</span>
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {t.name}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, fontSize: 10, color: 'var(--text-2)' }}>
        <span>MC ${fmtCompact(t.marketCapUsd)}</span>
        <span style={{ color: t.priceChange1h >= 0 ? 'var(--ok)' : 'var(--bad)' }}>
          {t.priceChange1h >= 0 ? '+' : ''}{t.priceChange1h?.toFixed?.(0) ?? 0}% 1h
        </span>
        <span>{t.pairAgeHours < 1 ? `${(t.pairAgeHours * 60).toFixed(0)}m` : `${t.pairAgeHours.toFixed(0)}h`} old</span>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-2)', fontStyle: 'italic' }}>
        {t.summary || 'on watch'}
      </div>
    </Link>
  );
}

function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return `${n.toFixed(0)}`;
}
