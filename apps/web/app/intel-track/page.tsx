'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useApi, invalidate } from '../../lib/useApi';
import { Skeleton } from '../../components/ui/Skeleton';
import { fmtUsdCompact } from '../../lib/format-price';

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

const SOURCE_LABEL: Record<Source, string> = {
  hot_tokens_scan: 'Hot scan',
  manual_scan: 'Manual',
  telegram_scan: 'Telegram',
  snipe: 'Snipe',
};

const STATUS_TONE: Record<Status, string> = {
  active: 'var(--accent)',
  graduated: 'var(--ok)',
  retired: 'var(--text-3)',
  rugged: 'var(--bad)',
};

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

export default function IntelTrackPage() {
  const [statusFilter, setStatusFilter] = useState<'all' | Status>('all');
  const [sourceFilter, setSourceFilter] = useState<'all' | Source>('all');
  const [showFresh, setShowFresh] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const queryStatus = statusFilter === 'all' ? 'active,graduated' : statusFilter;
  const querySource = sourceFilter === 'all' ? '' : `&source=${sourceFilter}`;
  // Hide entries that haven't moved at all yet — a capture from 1m ago with
  // no peak delta is noise, not a track record. Users can toggle "Show fresh"
  // to see them while they warm up.
  const minDelta = showFresh ? '' : '&minDelta=5';
  const path = `/intel-track?status=${queryStatus}${querySource}${minDelta}&take=120&sort=pumpedHigh`;

  const { data: rows, loading } = useApi<Snapshot[]>(path);
  const { data: stats } = useApi<Stats>('/intel-track/stats');

  const refresh = async () => {
    setRefreshing(true);
    invalidate(path);
    invalidate('/intel-track/stats');
    invalidate('/intel-track/top?limit=5');
    await new Promise((r) => setTimeout(r, 500));
    setRefreshing(false);
  };

  const items = useMemo(() => Array.isArray(rows) ? rows : [], [rows]);

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
          {items.map((s) => <Card key={s.id} s={s} />)}
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

function Card({ s }: { s: Snapshot }) {
  const tone = STATUS_TONE[s.status];
  return (
    <Link
      href={`/intel-track/detail?id=${s.id}`}
      style={{
        textDecoration: 'none', color: 'inherit',
        border: '1px solid var(--border)', borderRadius: 10,
        padding: '14px 16px', background: 'var(--surface-1)',
        display: 'flex', flexDirection: 'column', gap: 10,
        transition: 'border-color 0.12s ease, transform 0.12s ease',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>
            {s.status === 'graduated' && '🚀 '}
            {s.symbol ?? s.address.slice(0, 6)}
          </div>
          {s.name && s.name !== s.symbol && (
            <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{s.name}</div>
          )}
          <CopyCA address={s.address} />
        </div>
        <span className="chip" style={{
          background: `color-mix(in srgb, ${tone} 18%, transparent)`,
          borderColor: `color-mix(in srgb, ${tone} 40%, var(--border))`,
          color: tone, fontSize: 10, fontWeight: 600,
        }}>
          {s.status}
        </span>
      </div>

      <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
        {SOURCE_LABEL[s.source] ?? s.source}{s.profileKey ? ` · ${s.profileKey}` : ''}
        {' · '}captured {relTime(s.capturedAt)}
        {s.aiScore != null && ` · AI ${s.aiScore}/100`}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
        <Field label="Entry" value={fmtUsdCompact(s.marketCapUsdAtCapture)} />
        <Field label="Peak" value={fmtUsdCompact(s.pumpedHigh)} delta={s.peakDeltaPct} />
        <Field label="Now" value={fmtUsdCompact(s.currentMcapUsd)} delta={s.currentDeltaPct} />
      </div>

      <Sparkline values={s.sparkline ?? []} delta={s.peakDeltaPct ?? 0} />

      {s.reappearedAt && (
        <div style={{ fontSize: 10, color: 'var(--accent)' }}>
          ↺ re-appeared {relTime(s.reappearedAt)} ({s.reappearedSource})
        </div>
      )}
    </Link>
  );
}

function Field({ label, value, delta }: { label: string; value: string; delta?: number | null }) {
  const color = delta == null ? 'var(--text-1)' : delta >= 0 ? 'var(--ok)' : 'var(--bad)';
  return (
    <div>
      <div style={{ fontSize: 9, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {label}
      </div>
      <div className="font-mono" style={{ fontSize: 12, fontWeight: 600, color }}>
        {value}
      </div>
      {delta != null && (
        <div style={{ fontSize: 10, fontWeight: 600, color }}>
          {delta >= 0 ? '+' : ''}{delta.toFixed(0)}%
        </div>
      )}
    </div>
  );
}

function Sparkline({ values, delta }: { values: number[]; delta: number }) {
  if (!values?.length) return <div style={{ height: 32 }} />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const w = 200;
  const h = 32;
  const points = values.map((v, i) => {
    const x = (i / Math.max(values.length - 1, 1)) * w;
    const y = h - ((v - min) / range) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const stroke = delta >= 0 ? 'var(--ok)' : 'var(--bad)';
  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
      <polyline points={points} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
