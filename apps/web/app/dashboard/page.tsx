'use client';
import { useMemo, useState } from 'react';
import { Stat } from '../../components/ui/Stat';
import { ShortcutTile } from '../../components/ShortcutTile';
import { InsightCard } from '../../components/InsightCard';
import { useApi } from '../../lib/useApi';
import { matchesCategory, type InsightCategory, type TradeInsight, type RiskInsight, type Insight } from '../../lib/insights-mock';

/* ── API response shapes ── */
interface PerfData {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  sharpe: number;
  avgHoldMinutes: number;
  cumulativeReturns: number[];
  weekly: { trades: number; pnl: number; wins: number; losses: number; winRate: number };
}

interface AgentRow { id: string; status: string; kind: string; name?: string }
interface TradeRow {
  id: string; side: string; chain: string;
  tokenIn: string; tokenOut: string;
  amountIn: string; amountOut: string;
  pnlUsd: number | null; priceUsd: number | null;
  txHash: string | null; createdAt: string;
}
interface AlertRow {
  id: string; kind: string; severity: string;
  payload: Record<string, any>; createdAt: string;
}

/* ── helpers ── */
function fmtUsd(n: number): string {
  const abs = Math.abs(n);
  const s = abs >= 1000
    ? `$${(abs / 1000).toFixed(2)}k`
    : `$${abs.toFixed(2)}`;
  return n < 0 ? `-${s}` : s;
}

function fmtPct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

const CATEGORIES: { key: InsightCategory; label: string }[] = [
  { key: 'all',      label: 'All' },
  { key: 'trades',   label: 'Trades' },
  { key: 'research', label: 'Research' },
  { key: 'whales',   label: 'Whales' },
  { key: 'tokens',   label: 'Token intel' },
  { key: 'alerts',   label: 'Alerts' },
];

export default function Dashboard() {
  const [cat, setCat] = useState<InsightCategory>('all');

  const { data: perf }   = useApi<PerfData>('/analytics/performance');
  const { data: trades } = useApi<TradeRow[]>('/analytics/replay');
  const { data: alerts } = useApi<AlertRow[]>('/alerts?limit=20');
  const { data: agents } = useApi<AgentRow[]>('/agents');

  const runningCount = useMemo(
    () => agents?.filter((a) => a.status === 'RUNNING').length ?? 0,
    [agents],
  );

  const allInsights = useMemo<Insight[]>(() => {
    const tradeInsights: TradeInsight[] = (trades ?? []).map((t) => ({
      id: t.id,
      kind: 'trade',
      ts: t.createdAt,
      side: t.side as 'buy' | 'sell',
      status: 'filled' as const,
      qty: t.amountIn,
      price: t.priceUsd != null ? `$${t.priceUsd.toFixed(4)}` : '—',
      notional: t.amountIn,
      pnl: t.pnlUsd != null
        ? { value: fmtUsd(t.pnlUsd), tone: (t.pnlUsd >= 0 ? 'up' : 'down') as 'up' | 'down' }
        : undefined,
      reason: `${t.side} ${t.tokenOut}`,
      token: { symbol: t.tokenOut, chain: (t.chain === 'SOLANA' ? 'Solana' : 'EVM') as 'Solana' | 'EVM' },
    }));

    const riskInsights: RiskInsight[] = (alerts ?? []).map((a) => ({
      id: a.id,
      kind: 'risk',
      ts: a.createdAt,
      severity: (a.severity === 'CRITICAL' ? 'high' : a.severity === 'WARN' ? 'medium' : 'low') as 'low' | 'medium' | 'high',
      rule: a.kind,
      blocked: false,
      note: typeof a.payload === 'object' && a.payload
        ? (a.payload as any).message ?? a.kind
        : a.kind,
    }));

    return [...tradeInsights, ...riskInsights].sort(
      (a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime(),
    );
  }, [trades, alerts]);

  const feed = useMemo(
    () => allInsights.filter((i) => matchesCategory(i.kind, cat)),
    [allInsights, cat],
  );

  const counts = useMemo(() => {
    const c: Record<InsightCategory, number> = { all: 0, trades: 0, research: 0, whales: 0, tokens: 0, alerts: 0 };
    for (const item of allInsights) {
      for (const k of Object.keys(c) as InsightCategory[]) {
        if (matchesCategory(item.kind, k)) c[k]++;
      }
    }
    return c;
  }, [allInsights]);

  return (
    <div className="page space-y-4 md:space-y-5">
      <PortfolioStrip perf={perf} runningAgents={runningCount} />
      <ShortcutGrid runningAgents={runningCount} />

      <section className="section">
        <header className="section-header" style={{ position: 'sticky', top: 'var(--topbar-h, 44px)', zIndex: 5, background: 'var(--surface)' }}>
          <div className="flex items-center gap-1 -ml-1 overflow-x-auto no-scrollbar" style={{ minWidth: 0, flex: 1 }}>
            {CATEGORIES.map((c) => {
              const active = cat === c.key;
              return (
                <button
                  key={c.key}
                  onClick={() => setCat(c.key)}
                  className="btn btn-sm"
                  style={{
                    borderColor: active ? 'color-mix(in srgb, var(--accent) 55%, var(--border-2))' : 'transparent',
                    background: active ? 'color-mix(in srgb, var(--accent) 12%, var(--surface-2))' : 'transparent',
                    color: active ? 'var(--text)' : 'var(--text-2)',
                    boxShadow: 'none',
                  }}
                >
                  {c.label}
                  <span className="kbd" style={{ marginLeft: 6, height: 16, fontSize: 10, padding: '0 4px' }}>
                    {counts[c.key]}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="section-actions">
            <button className="btn btn-sm btn-ghost">Filter</button>
          </div>
        </header>
        <div className="section-body-flush">
          <div className="p-3.5 space-y-2.5">
            {feed.length === 0 ? <EmptyState /> : feed.map((item) => <InsightCard key={item.id} item={item} />)}
          </div>
        </div>
      </section>
    </div>
  );
}

/* ---------- Portfolio strip ---------- */

function PortfolioStrip({ perf, runningAgents }: { perf: PerfData | undefined; runningAgents: number }) {
  const loading = perf === undefined;
  const pnl     = loading ? '—' : fmtUsd(perf.totalPnl);
  const pnlTone = !loading && perf.totalPnl < 0 ? 'down' : 'up';
  const weekPnl = loading ? undefined : fmtUsd(perf.weekly.pnl);
  const weekTone = !loading && perf.weekly.pnl < 0 ? 'down' as const : 'up' as const;

  return (
    <section className="section">
      <header className="section-header">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="section-eyebrow">Dashboard</span>
          <span style={{ color: 'var(--text-3)' }}>·</span>
          <span className="text-[12.5px]" style={{ color: 'var(--text-2)' }}>
            What your agent has been doing for you
          </span>
        </div>
        <div className="section-actions">
          <span className="chip"><span className="live-dot" /> live</span>
        </div>
      </header>
      <div className="section-body">
        <div className="grid-stats">
          <Stat size="hero" label="Realised P&L" value={pnl} deltaTone={pnlTone}
            hint={weekPnl ? `${weekPnl} this week` : undefined} />
          <Stat label="Win rate"
            value={loading ? '—' : fmtPct(perf.winRate)}
            delta={loading ? undefined : `${perf.wins}W / ${perf.losses}L`}
            deltaTone="flat" />
          <Stat label="Total trades"
            value={loading ? '—' : String(perf.totalTrades)}
            delta={loading || perf.weekly.trades === 0 ? undefined : `+${perf.weekly.trades} this week`}
            deltaTone="flat" />
          <Stat label="Avg P&L / trade"
            value={loading ? '—' : fmtUsd(perf.avgPnl)}
            deltaTone={!loading && perf.avgPnl < 0 ? 'down' : 'up'} />
          <Stat label="Agents running"
            value={String(runningAgents)}
            delta={runningAgents === 0 ? 'none active' : `${runningAgents} active`}
            deltaTone="flat" />
        </div>
      </div>
    </section>
  );
}

/* ---------- Shortcut grid ---------- */

function ShortcutGrid({ runningAgents }: { runningAgents: number }) {
  return (
    <section>
      <div className="flex items-baseline justify-between mb-2.5 px-0.5">
        <h2 className="section-eyebrow">Shortcuts</h2>
        <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>
          Jump straight to any feature
        </span>
      </div>
      <div className="grid-cards">
        <ShortcutTile href="/trade"     label="Trade"      hint="Chart, swap, risk"       icon={<SvgTrade />}    tone="accent" />
        <ShortcutTile href="/agents"    label="Agents"     hint="DCA, stop, copy, snipe"  icon={<SvgAgents />}   tone="accent-2"
          badge={runningAgents > 0 ? { text: `${runningAgents} running`, tone: 'accent-2' } : undefined} />
        <ShortcutTile href="/tokens"    label="Token intel" hint="Conviction + rug score" icon={<SvgGem />}      tone="accent" />
        <ShortcutTile href="/wallets"   label="Wallets"    hint="Solana + EVM"            icon={<SvgWallet />}   tone="accent" />
        <ShortcutTile href="/chat"      label="Chat"       hint="Talk to your agent"      icon={<SvgChat />}     tone="accent-2" />
        <ShortcutTile href="/analytics" label="Analytics"  hint="Journal, P&L, stats"    icon={<SvgAnalytics />} tone="accent" />
        <ShortcutTile href="/social"    label="Social"     hint="X · Farcaster · TG"      icon={<SvgSocial />}   tone="accent-2" />
        <ShortcutTile href="/settings"  label="Settings"   hint="Guardrails, keys, notifs" icon={<SvgSettings />} tone="accent" />
      </div>
    </section>
  );
}

function EmptyState() {
  return (
    <div
      className="rounded-[10px] p-6 text-center"
      style={{ background: 'var(--surface-2)', border: '1px dashed var(--border-2)' }}
    >
      <div className="text-[13px] font-semibold">Nothing here yet</div>
      <div className="text-[12px] mt-1" style={{ color: 'var(--text-3)' }}>
        Trades and alerts will appear here once your agent starts running.
      </div>
    </div>
  );
}

/* ---------- Icons (18px, 1.5 stroke) ---------- */

function Ico({ children }: { children: React.ReactNode }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}
function SvgTrade()     { return <Ico><path d="M3 17l6-6 4 4 8-8"/><path d="M21 7h-5"/><path d="M21 7v5"/></Ico>; }
function SvgAgents()    { return <Ico><circle cx="12" cy="8" r="3"/><path d="M5 20c0-3.5 3-6 7-6s7 2.5 7 6"/><path d="M12 2v2"/><path d="M4 8h2"/><path d="M18 8h2"/></Ico>; }
function SvgGem()       { return <Ico><path d="M6 3h12l3 6-9 12L3 9z"/><path d="M3 9h18"/></Ico>; }
function SvgWallet()    { return <Ico><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M16 12h3"/><path d="M3 10h18"/></Ico>; }
function SvgChat()      { return <Ico><path d="M21 12a8 8 0 0 1-11.3 7.3L4 21l1.7-5.7A8 8 0 1 1 21 12z"/></Ico>; }
function SvgAnalytics() { return <Ico><path d="M3 20h18"/><path d="M6 16V9"/><path d="M11 16V5"/><path d="M16 16v-4"/><path d="M21 16V8"/></Ico>; }
function SvgSocial()    { return <Ico><circle cx="9" cy="7" r="3"/><circle cx="17" cy="17" r="3"/><path d="M6 14c-1.7 0-3 1.3-3 3v3h8"/><path d="M14 6c1.7 0 3 1.3 3 3v3"/></Ico>; }
function SvgSettings()  { return <Ico><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h0a1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></Ico>; }
