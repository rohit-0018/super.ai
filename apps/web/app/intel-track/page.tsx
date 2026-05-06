'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { useApi, invalidate } from '../../lib/useApi';
import { useRealtime } from '../../lib/useRealtime';
import { Skeleton } from '../../components/ui/Skeleton';
import { useTokenPool } from '../../lib/TokenPoolContext';
import { TokenCard } from '../../components/TokenCard';
import { SignalResult } from '../../components/SignalBanner';

type Status = 'active' | 'retired' | 'rugged' | 'graduated';
type Source = 'hot_tokens_scan' | 'manual_scan' | 'telegram_scan' | 'snipe';

interface Snapshot {
  id: string;
  chain: string;
  address: string;
  symbol: string | null;
  name: string | null;
  capturedAt: string;
  source: Source;
  profileKey: string | null;
  marketCapUsdAtCapture: number | null;
  liquidityUsdAtCapture: number | null;
  pumpedHigh: number | null;
  pumpedHighAt: string | null;
  currentMcapUsd: number | null;
  rescanCount: number;
  status: Status;
  sparkline: number[];
  aiScore: number | null;
  aiVerdict: string | null;
  aiSummary: string | null;
  killTriggered: boolean;
  reappearedAt: string | null;
  reappearedSource: string | null;
  peakDeltaPct: number | null;
  currentDeltaPct: number | null;
}

interface Stats {
  totalSnapshots: number;
  graduated: number;
  retired: number;
  rugged: number;
  active: number;
  avgPeakDeltaPct: number;
  bestCall: { symbol: string | null; deltaPct: number | null } | null;
}

interface SignalExtra {
  t1Pct?: number;
  t2Pct?: number;
  stopLossPct?: number;
  riskReward?: number;
  aiSummary?: string | null;
  holdRange?: string;
}

export default function IntelTrackPage() {
  const [statusFilter, setStatusFilter] = useState<'all' | Status>('all');
  const [sourceFilter, setSourceFilter] = useState<'all' | Source>('all');
  const [showFresh, setShowFresh] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const queryStatus = statusFilter === 'all' ? 'active,graduated' : statusFilter;
  const querySource = sourceFilter === 'all' ? '' : `&source=${sourceFilter}`;
  const minDelta = showFresh ? '' : '&minDelta=5';
  const path = `/intel-track?status=${queryStatus}${querySource}${minDelta}&take=120&sort=recent`;

  const { data: rows, loading } = useApi<Snapshot[]>(path);
  const { data: stats } = useApi<Stats>('/intel-track/stats');
  const { data: cachedSignals } = useApi<SignalResult[]>('/hot-tokens/signals', { ttlMs: 60_000 });

  // Overlay: address → signal data received after page load
  const [signalOverlay, setSignalOverlay] = useState<Record<string, { score: number; verdict: string }>>({});
  const [signalExtras, setSignalExtras]   = useState<Record<string, SignalExtra>>({});
  const [analysisTriggered, setAnalysisTriggered] = useState(false);
  const enqueuedRef = useRef(false);

  const baseItems = useMemo(() => Array.isArray(rows) ? rows : [], [rows]);

  // Merge DB rows with any signal overlay received via WS or hydration
  const items = useMemo(() =>
    baseItems.map((s) => {
      const ov = signalOverlay[s.address];
      return ov && !s.aiVerdict ? { ...s, aiScore: ov.score, aiVerdict: ov.verdict } : s;
    }),
  [baseItems, signalOverlay]);

  // Hydrate from pipeline's in-memory results on page load
  useEffect(() => {
    if (!Array.isArray(cachedSignals) || !cachedSignals.length) return;
    const overlay: Record<string, { score: number; verdict: string }> = {};
    const extras: Record<string, SignalExtra> = {};
    for (const s of cachedSignals) {
      overlay[s.address] = { score: s.score, verdict: s.verdict };
      extras[s.address]  = { t1Pct: s.t1Pct, t2Pct: s.t2Pct, stopLossPct: s.stopLossPct, riskReward: s.riskReward, aiSummary: s.aiSummary, holdRange: s.holdRange };
    }
    setSignalOverlay((prev) => ({ ...overlay, ...prev }));
    setSignalExtras((prev) => ({ ...extras, ...prev }));
  }, [cachedSignals]);

  // Live updates — pipeline emits this whenever a token finishes analysis
  const onSignalAnalysis = useCallback((result: SignalResult) => {
    if (!result?.address) return;
    setSignalOverlay((prev) => ({ ...prev, [result.address]: { score: result.score, verdict: result.verdict } }));
    setSignalExtras((prev) => ({
      ...prev,
      [result.address]: { t1Pct: result.t1Pct, t2Pct: result.t2Pct, stopLossPct: result.stopLossPct, riskReward: result.riskReward, aiSummary: result.aiSummary, holdRange: result.holdRange },
    }));
  }, []);
  useRealtime('signal_analysis', onSignalAnalysis);

  // Enqueue unanalyzed cards for background AI analysis once rows load
  useEffect(() => {
    if (!baseItems.length || enqueuedRef.current) return;
    enqueuedRef.current = true;
    const toAnalyze = baseItems
      .filter((i) => !i.aiVerdict)
      .slice(0, 20)
      .map((i) => ({ address: i.address, symbol: i.symbol ?? i.address.slice(0, 6), profileKey: i.profileKey ?? 'meme_hunter' }));
    if (!toAnalyze.length) return;
    api.post('/hot-tokens/signals/analyze', { items: toAnalyze })
      .then(() => setAnalysisTriggered(true))
      .catch(() => {});
  }, [baseItems]);

  const refresh = async () => {
    setRefreshing(true);
    enqueuedRef.current = false; // allow re-enqueue after manual refresh
    invalidate(path);
    invalidate('/intel-track/stats');
    invalidate('/intel-track/top?limit=5');
    await new Promise((r) => setTimeout(r, 500));
    setRefreshing(false);
  };

  return (
    <div className="page space-y-4">
      <header className="page-header">
        <div>
          <div className="section-eyebrow">Track Record</div>
          <h1 className="page-title">Intel Track</h1>
          <p className="page-subtitle">
            Every meaningful call the bot ever made — frozen at capture, re-scanned every 10 min,
            and ranked by realized peak delta.
          </p>
        </div>
        <div className="section-actions" style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing}
            className="btn btn-sm"
            style={{ fontSize: 11, opacity: refreshing ? 0.6 : 1 }}
          >
            {refreshing ? '⟳ refreshing…' : '↻ Refresh'}
          </button>
        </div>
      </header>

      {stats && <StatsHero stats={stats} />}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <FilterChips
          label="Status"
          options={[
            ['all', 'All'],
            ['active', 'Active'],
            ['graduated', 'Graduated 🚀'],
            ['retired', 'Retired'],
            ['rugged', 'Rugged'],
          ]}
          value={statusFilter}
          onChange={(v) => setStatusFilter(v as any)}
        />
        <FilterChips
          label="Source"
          options={[
            ['all', 'All'],
            ['hot_tokens_scan', 'Hot scan'],
            ['manual_scan', 'Manual'],
            ['telegram_scan', 'Telegram'],
            ['snipe', 'Snipe'],
          ]}
          value={sourceFilter}
          onChange={(v) => setSourceFilter(v as any)}
        />
        <label style={{
          display: 'flex', alignItems: 'center', gap: 6,
          fontSize: 11, color: 'var(--text-2)', cursor: 'pointer',
          padding: '4px 10px', borderRadius: 999,
          background: showFresh ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : 'var(--surface-2)',
          border: `1px solid ${showFresh ? 'var(--accent)' : 'var(--border)'}`,
        }}>
          <input
            type="checkbox"
            checked={showFresh}
            onChange={(e) => setShowFresh(e.target.checked)}
            style={{ accentColor: 'var(--accent)', margin: 0 }}
          />
          Show fresh (no peak yet)
        </label>
      </div>

      {loading ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
          {[...Array(8)].map((_, i) => <Skeleton key={i} h={200} rounded="md" />)}
        </div>
      ) : items.length === 0 ? (
        <div className="panel" style={{ padding: '32px 24px', textAlign: 'center' }}>
          <div style={{ fontSize: 32, marginBottom: 10, opacity: 0.4 }}>📭</div>
          <p className="text-[14px] font-semibold" style={{ color: 'var(--text-2)' }}>
            {showFresh ? 'No track-record entries yet.' : 'Nothing meaningful to show yet.'}
          </p>
          <p className="text-[12px] mt-2" style={{ color: 'var(--text-3)', maxWidth: 480, margin: '8px auto 0' }}>
            {showFresh
              ? 'Captures appear here as the bot scans tokens. Peak deltas develop over hours, not minutes.'
              : 'Recent captures haven\'t moved enough yet to be marketing-grade. Toggle "Show fresh" above to view warming-up entries.'}
          </p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
          {items.map((s) => <Card key={s.id} s={s} extra={signalExtras[s.address]} pendingAnalysis={analysisTriggered} />)}
        </div>
      )}
    </div>
  );
}

function StatsHero({ stats }: { stats: Stats }) {
  return (
    <section className="section" style={{ padding: '14px 18px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 16 }}>
        <Stat label="Captures total" value={stats.totalSnapshots.toString()} />
        <Stat label="Graduated 10x+" value={stats.graduated.toString()} tone="up" />
        <Stat label="Active" value={stats.active.toString()} />
        <Stat
          label="Avg peak delta"
          value={`${stats.avgPeakDeltaPct >= 0 ? '+' : ''}${stats.avgPeakDeltaPct.toFixed(0)}%`}
          tone={stats.avgPeakDeltaPct >= 0 ? 'up' : 'down'}
        />
        <Stat label="Rugged" value={stats.rugged.toString()} tone="down" muted />
      </div>
      {stats.bestCall && (
        <div style={{ marginTop: 12, padding: '10px 12px', background: 'var(--surface-2)', borderRadius: 8 }}>
          <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>Biggest call: </span>
          <span style={{ fontWeight: 700 }}>{stats.bestCall.symbol ?? 'unknown'}</span>
          {stats.bestCall.deltaPct != null && (
            <span style={{ marginLeft: 8, color: 'var(--ok)', fontWeight: 700 }}>
              +{stats.bestCall.deltaPct.toFixed(0)}%
            </span>
          )}
        </div>
      )}
    </section>
  );
}

function Stat({ label, value, tone, muted }: { label: string; value: string; tone?: 'up' | 'down'; muted?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        {label}
      </div>
      <div style={{
        fontSize: 22, fontWeight: 700, marginTop: 4,
        color: tone === 'up' ? 'var(--ok)' : tone === 'down' ? 'var(--bad)' : 'var(--text-1)',
        opacity: muted ? 0.6 : 1,
      }}>
        {value}
      </div>
    </div>
  );
}

function FilterChips({ label, options, value, onChange }: {
  label: string;
  options: [string, string][];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        {label}
      </span>
      {options.map(([k, l]) => (
        <button
          key={k}
          type="button"
          onClick={() => onChange(k)}
          className="chip"
          style={{
            cursor: 'pointer',
            background: value === k ? 'color-mix(in srgb, var(--accent) 22%, transparent)' : 'var(--surface-2)',
            borderColor: value === k ? 'var(--accent)' : 'var(--border)',
            fontSize: 11,
          }}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

/* ── Card: thin wrapper that resolves pool data then delegates to TokenCard ── */
function Card({ s, extra, pendingAnalysis }: { s: Snapshot; extra?: SignalExtra; pendingAnalysis: boolean }) {
  const pool  = useTokenPool();
  const live  = pool[s.address];
  const currentMcap  = live?.marketCapUsd ?? s.currentMcapUsd;
  const currentDelta =
    live && s.marketCapUsdAtCapture
      ? ((live.marketCapUsd - s.marketCapUsdAtCapture) / s.marketCapUsdAtCapture) * 100
      : s.currentDeltaPct;

  // Show Analyzing… spinner for unanalyzed cards once batch analysis is triggered
  const isFresh = pendingAnalysis && !s.aiVerdict ? false : undefined;

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
      sparkline={s.sparkline ?? []}
      aiScore={s.aiScore}
      aiVerdict={s.aiVerdict}
      aiSummary={s.aiSummary ?? extra?.aiSummary}
      t1Pct={extra?.t1Pct}
      riskReward={extra?.riskReward}
      isFresh={isFresh}
      reappearedAt={s.reappearedAt}
      reappearedSource={s.reappearedSource}
    />
  );
}
