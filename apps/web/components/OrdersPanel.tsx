'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../lib/useApi';
import { Skeleton } from './ui/Skeleton';

// ─────────────────────────────────────────────────────────────────────────────
// Types — must match apps/api/src/activity/activity.service.ts ActivityItem
// ─────────────────────────────────────────────────────────────────────────────

interface ActivityItem {
  id: string;
  kind: 'ORDER' | 'TRADE';
  createdAt: string;
  source: string;
  status: string;
  type?: string | null;
  side?: 'buy' | 'sell' | null;
  chain: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut?: string | null;
  notionalUsd?: number | null;
  mode?: 'LIVE' | 'PAPER' | null;
  txHash: string | null;
  explorerUrl: string | null;
  walletId?: string | null;
  orderId?: string | null;
  simulated: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Filter chips
// ─────────────────────────────────────────────────────────────────────────────

type StatusFilter = 'all' | 'open' | 'filled' | 'failed' | 'simulated';
type SourceFilter = 'all' | 'WEB' | 'CHAT' | 'TELEGRAM' | 'AGENT' | 'DCA' | 'SCHEDULED' | 'FAST_LANE';

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'filled', label: 'Filled' },
  { key: 'failed', label: 'Failed' },
  { key: 'simulated', label: 'Simulated' },
];

const SOURCE_FILTERS: { key: SourceFilter; label: string; emoji: string }[] = [
  { key: 'all', label: 'All sources', emoji: '⚡' },
  { key: 'WEB', label: 'Web', emoji: '🖥️' },
  { key: 'CHAT', label: 'Chat', emoji: '💬' },
  { key: 'TELEGRAM', label: 'Telegram', emoji: '✈️' },
  { key: 'AGENT', label: 'Agent', emoji: '🤖' },
  { key: 'DCA', label: 'DCA', emoji: '📈' },
  { key: 'SCHEDULED', label: 'Scheduled', emoji: '⏱️' },
  { key: 'FAST_LANE', label: 'Fast Lane', emoji: '🚀' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export default function OrdersPanel() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data, loading, error, refresh } = useApi<ActivityItem[]>('/activity', {
    pollMs: 4000,
  });
  const items = data ?? [];

  // Track newly arrived rows for entry animation flash
  const seenIds = useRef<Set<string>>(new Set());
  const [flashIds, setFlashIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!items.length) return;
    const fresh: string[] = [];
    for (const it of items) {
      if (!seenIds.current.has(it.id)) {
        seenIds.current.add(it.id);
        fresh.push(it.id);
      }
    }
    if (fresh.length === 0) return;
    // First load — don't flash everything, just remember it
    if (flashIds.size === 0 && seenIds.current.size === items.length) return;
    setFlashIds((prev) => {
      const next = new Set(prev);
      fresh.forEach((id) => next.add(id));
      return next;
    });
    const t = setTimeout(() => {
      setFlashIds((prev) => {
        const next = new Set(prev);
        fresh.forEach((id) => next.delete(id));
        return next;
      });
    }, 1600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.map((i) => i.id).join('|')]);

  const filtered = useMemo(() => {
    return items.filter((it) => {
      if (sourceFilter !== 'all' && it.source !== sourceFilter) return false;
      if (statusFilter === 'all') return true;
      if (statusFilter === 'simulated') return it.simulated;
      const s = it.status.toLowerCase();
      if (statusFilter === 'open') return s === 'pending' || s === 'active';
      if (statusFilter === 'filled') return s === 'filled' || s === 'executed';
      if (statusFilter === 'failed') return s === 'failed' || s === 'cancelled';
      return true;
    });
  }, [items, statusFilter, sourceFilter]);

  const counts = useMemo(() => {
    const c: Record<SourceFilter, number> = {
      all: items.length,
      WEB: 0, CHAT: 0, TELEGRAM: 0, AGENT: 0, DCA: 0, SCHEDULED: 0, FAST_LANE: 0,
    };
    for (const it of items) {
      const s = (it.source as SourceFilter) ?? 'WEB';
      if (s in c) c[s] = (c[s] ?? 0) + 1;
    }
    return c;
  }, [items]);

  return (
    <div className="panel orders-panel">
      {/* Header */}
      <div className="flex items-start justify-between mb-3 gap-3 flex-wrap">
        <div>
          <h3 className="section-title mb-0 flex items-center gap-2">
            <span className="orders-pulse-dot" aria-hidden />
            Orders & Activity
          </h3>
          <p className="text-[12px] text-[color:var(--text-3)] mt-0.5">
            Every trade your account placed — web, chat, telegram, agents, DCA, fast lane.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="chip orders-live-chip">
            <span className="w-1.5 h-1.5 rounded-full bg-[color:var(--ok)]" />
            Live · {items.length}
          </span>
          <button
            onClick={() => refresh()}
            className="btn btn-ghost btn-sm"
            title="Refresh"
          >
            ↻
          </button>
        </div>
      </div>

      {/* Filter rows */}
      <div className="space-y-2 mb-3">
        <div className="flex gap-1.5 flex-wrap">
          {STATUS_FILTERS.map((f) => (
            <FilterChip
              key={f.key}
              active={statusFilter === f.key}
              onClick={() => setStatusFilter(f.key)}
            >
              {f.label}
            </FilterChip>
          ))}
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {SOURCE_FILTERS.map((f) => (
            <FilterChip
              key={f.key}
              active={sourceFilter === f.key}
              onClick={() => setSourceFilter(f.key)}
              dim={f.key !== 'all' && counts[f.key] === 0}
            >
              <span className="mr-1">{f.emoji}</span>
              {f.label}
              {f.key !== 'all' && counts[f.key] > 0 && (
                <span className="ml-1.5 text-[10px] opacity-70">{counts[f.key]}</span>
              )}
            </FilterChip>
          ))}
        </div>
      </div>

      {/* List */}
      <div className="orders-list">
        {loading && !data ? (
          Array.from({ length: 5 }).map((_, i) => <SkeletonRow key={i} />)
        ) : error ? (
          <div className="text-[color:var(--bad)] py-8 text-center text-[13px]">{error}</div>
        ) : filtered.length === 0 ? (
          <EmptyState statusFilter={statusFilter} sourceFilter={sourceFilter} />
        ) : (
          filtered.map((it, idx) => (
            <OrderRow
              key={it.id}
              item={it}
              expanded={expanded === it.id}
              onToggle={() => setExpanded((e) => (e === it.id ? null : it.id))}
              flashing={flashIds.has(it.id)}
              index={idx}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Row
// ─────────────────────────────────────────────────────────────────────────────

function OrderRow({
  item,
  expanded,
  onToggle,
  flashing,
  index,
}: {
  item: ActivityItem;
  expanded: boolean;
  onToggle: () => void;
  flashing: boolean;
  index: number;
}) {
  const accent = statusAccent(item);
  return (
    <div
      className={`order-row ${flashing ? 'order-row--flash' : ''} ${expanded ? 'order-row--expanded' : ''}`}
      style={{
        animationDelay: `${Math.min(index * 30, 240)}ms`,
        borderLeftColor: accent,
      }}
      onClick={onToggle}
      role="button"
      tabIndex={0}
    >
      <div className="order-row__main">
        <div className="order-row__left">
          <SideBadge side={item.side} kind={item.kind} />
          <div className="min-w-0">
            <div className="order-row__title">
              <span className="font-medium">
                {actionLabel(item)}
              </span>
              <span className="text-[color:var(--text-3)] text-[12px]">
                {item.kind === 'ORDER' ? item.type ?? 'ORDER' : 'TRADE'}
              </span>
            </div>
            <div className="order-row__meta">
              <SourceChip source={item.source} />
              <span className="text-[color:var(--text-3)]">·</span>
              <span className="font-mono text-[11px] text-[color:var(--text-3)]">
                {item.chain}
              </span>
              <span className="text-[color:var(--text-3)]">·</span>
              <span className="text-[11px] text-[color:var(--text-3)]">
                {timeAgo(item.createdAt)}
              </span>
              {item.simulated && (
                <>
                  <span className="text-[color:var(--text-3)]">·</span>
                  <span className="orders-sim-pill">SIM</span>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="order-row__right">
          {item.notionalUsd != null && item.notionalUsd > 0 && (
            <div className="text-[13px] font-mono">
              ${item.notionalUsd.toFixed(2)}
            </div>
          )}
          <StatusPill status={item.status} simulated={item.simulated} />
          <span className={`order-row__chev ${expanded ? 'order-row__chev--open' : ''}`}>
            ›
          </span>
        </div>
      </div>

      {expanded && (
        <div className="order-row__detail" onClick={(e) => e.stopPropagation()}>
          <DetailGrid item={item} />
        </div>
      )}
    </div>
  );
}

function DetailGrid({ item }: { item: ActivityItem }) {
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-[12px]">
      <DetailField label="Token in" value={item.tokenIn} mono truncate />
      <DetailField label="Token out" value={item.tokenOut} mono truncate />
      <DetailField label="Amount in" value={item.amountIn} mono />
      <DetailField label="Amount out" value={item.amountOut ?? '—'} mono />
      <DetailField label="Side" value={item.side ?? '—'} />
      <DetailField label="Mode" value={item.mode ?? '—'} />
      <DetailField label="Source" value={item.source} />
      <DetailField label="Status" value={item.status} />
      <DetailField label="Created" value={new Date(item.createdAt).toLocaleString()} />
      <DetailField
        label="Tx hash"
        value={item.txHash ?? '—'}
        mono
        truncate
      />
      <div className="col-span-2 flex items-center gap-3 mt-1">
        {item.explorerUrl ? (
          <a
            href={item.explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="orders-verify-btn"
          >
            🔗 Verify on chain →
          </a>
        ) : item.simulated ? (
          <span className="text-[11px] text-[color:var(--text-3)] italic">
            Simulated — no on-chain transaction to verify
          </span>
        ) : (
          <span className="text-[11px] text-[color:var(--text-3)] italic">
            No tx hash recorded
          </span>
        )}
      </div>
    </div>
  );
}

function DetailField({
  label,
  value,
  mono,
  truncate,
}: {
  label: string;
  value: string;
  mono?: boolean;
  truncate?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-[color:var(--text-3)]">
        {label}
      </div>
      <div
        className={`${mono ? 'font-mono' : ''} ${truncate ? 'truncate' : ''} text-[12px] text-[color:var(--text)]`}
        title={value}
      >
        {value}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function FilterChip({
  active,
  onClick,
  children,
  dim,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  dim?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`orders-filter-chip ${active ? 'orders-filter-chip--active' : ''} ${dim ? 'orders-filter-chip--dim' : ''}`}
    >
      {children}
    </button>
  );
}

function SourceChip({ source }: { source: string }) {
  const meta = SOURCE_FILTERS.find((s) => s.key === source);
  const emoji = meta?.emoji ?? '·';
  const label = meta?.label ?? source;
  return (
    <span className="orders-source-chip" title={`Source: ${label}`}>
      <span>{emoji}</span>
      <span className="text-[11px]">{label}</span>
    </span>
  );
}

function SideBadge({ side, kind }: { side?: 'buy' | 'sell' | null; kind: 'ORDER' | 'TRADE' }) {
  if (!side) {
    return <div className="orders-side-badge orders-side-badge--neutral">{kind === 'ORDER' ? '◊' : '·'}</div>;
  }
  return (
    <div
      className={`orders-side-badge ${side === 'buy' ? 'orders-side-badge--buy' : 'orders-side-badge--sell'}`}
    >
      {side === 'buy' ? '↑' : '↓'}
    </div>
  );
}

function StatusPill({ status, simulated }: { status: string; simulated: boolean }) {
  const s = status.toUpperCase();
  let color = 'var(--text-2)';
  let bg = 'transparent';
  if (s === 'FILLED' || s === 'EXECUTED' || s === 'CONFIRMED') {
    color = 'var(--ok)';
    bg = 'color-mix(in srgb, var(--ok) 12%, transparent)';
  } else if (s === 'FAILED') {
    color = 'var(--bad)';
    bg = 'color-mix(in srgb, var(--bad) 12%, transparent)';
  } else if (s === 'PENDING' || s === 'ACTIVE') {
    color = 'var(--warn)';
    bg = 'color-mix(in srgb, var(--warn) 14%, transparent)';
  } else if (s === 'CANCELLED') {
    color = 'var(--text-3)';
    bg = 'color-mix(in srgb, var(--text-3) 14%, transparent)';
  } else if (s === 'SIMULATED') {
    color = '#a78bfa';
    bg = 'color-mix(in srgb, #a78bfa 16%, transparent)';
  }
  if (simulated && s !== 'SIMULATED') {
    bg = 'color-mix(in srgb, #a78bfa 14%, transparent)';
  }
  return (
    <span className="orders-status-pill" style={{ color, background: bg }}>
      <span
        className="w-1.5 h-1.5 rounded-full"
        style={{ background: color }}
      />
      {s}
    </span>
  );
}

function SkeletonRow() {
  return (
    <div className="order-row order-row--skeleton">
      <div className="order-row__main">
        <div className="order-row__left">
          <Skeleton w={28} h={28} rounded="md" />
          <div className="space-y-1.5">
            <Skeleton w={140} h={12} />
            <Skeleton w={200} h={10} />
          </div>
        </div>
        <div className="order-row__right">
          <Skeleton w={48} h={12} />
          <Skeleton w={64} h={20} rounded="md" />
        </div>
      </div>
    </div>
  );
}

function EmptyState({ statusFilter, sourceFilter }: { statusFilter: StatusFilter; sourceFilter: SourceFilter }) {
  const empty = statusFilter === 'all' && sourceFilter === 'all';
  return (
    <div className="orders-empty">
      <div className="orders-empty__icon">📭</div>
      <div className="text-[13px] font-medium">
        {empty ? 'No orders yet' : 'No matching orders'}
      </div>
      <div className="text-[12px] text-[color:var(--text-3)] mt-1 max-w-md">
        {empty
          ? 'Place your first trade from the Swap form, or ask QWAI in chat. Telegram, agent, fast-lane and scheduled orders will all show up here.'
          : 'Try a different filter — every channel\'s orders end up in this feed.'}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function statusAccent(item: ActivityItem): string {
  const s = item.status.toUpperCase();
  if (s === 'FILLED' || s === 'EXECUTED' || s === 'CONFIRMED') return 'var(--ok)';
  if (s === 'FAILED') return 'var(--bad)';
  if (s === 'PENDING' || s === 'ACTIVE') return 'var(--warn)';
  if (item.simulated) return '#a78bfa';
  return 'transparent';
}

function actionLabel(item: ActivityItem): string {
  const verb = item.side === 'buy' ? 'Buy' : item.side === 'sell' ? 'Sell' : 'Swap';
  const inSym = item.tokenIn.length > 10 ? item.tokenIn.slice(0, 4) + '…' : item.tokenIn;
  const outSym = item.tokenOut.length > 10 ? item.tokenOut.slice(0, 4) + '…' : item.tokenOut;
  return `${verb} ${inSym} → ${outSym}`;
}

function timeAgo(iso: string): string {
  const now = Date.now();
  const t = new Date(iso).getTime();
  const diff = Math.max(0, now - t);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}
