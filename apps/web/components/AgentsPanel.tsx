'use client';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useApi, invalidate } from '../lib/useApi';
import { Skeleton } from './ui/Skeleton';

type AgentKind = 'DCA' | 'STOP_LOSS' | 'COPY_TRADE' | 'POSITION_MONITOR' | 'SNIPE' | 'BRIEFING';
type AgentStatus = 'RUNNING' | 'PAUSED' | 'KILLED';

interface AgentParams {
  walletId?: string;
  tokenIn?: string;
  tokenOut?: string;
  amountUsd?: number;
  interval?: string;
  chain?: string;
  slippageBps?: number;
  stopPrice?: number;
  srcWallet?: string;
  symbol?: string;
  orderId?: string;
  [key: string]: unknown;
}

interface Agent {
  id: string;
  kind: AgentKind;
  status: AgentStatus;
  params: AgentParams;
  lastRunAt?: string | null;
  createdAt: string;
}

const KIND_META: Record<AgentKind, { label: string; icon: string; color: string; desc: string }> = {
  DCA:              { label: 'DCA',              icon: '∑',  color: '#22c55e', desc: 'Dollar-cost averaging' },
  STOP_LOSS:        { label: 'Stop Loss',        icon: '⎯',  color: '#ef4444', desc: 'Auto-sell on price drop' },
  COPY_TRADE:       { label: 'Copy Trade',       icon: '⇌',  color: '#3b82f6', desc: 'Mirror wallet trades' },
  POSITION_MONITOR: { label: 'Position Monitor', icon: '◎',  color: '#f59e0b', desc: 'Watch positions 24/7' },
  SNIPE:            { label: 'Snipe',            icon: '⚡', color: '#a855f7', desc: 'New token sniping' },
  BRIEFING:         { label: 'Briefing',         icon: '☼',  color: '#06b6d4', desc: 'Daily market briefing' },
};

export default function AgentsPanel() {
  const { data: agents, loading, error } = useApi<Agent[]>('/agents', { pollMs: 10_000 });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  async function act(agent: Agent, action: 'pause' | 'resume' | 'kill') {
    setBusyId(agent.id);
    setActionError(null);
    try {
      if (action === 'kill') await api.delete(`/agents/${agent.id}`);
      else await api.post(`/agents/${agent.id}/${action}`, {});
      invalidate('/agents');
    } catch (e: any) {
      setActionError(e?.message ?? 'Action failed');
    } finally {
      setBusyId(null);
    }
  }

  const alive = agents?.filter((a) => a.status !== 'KILLED') ?? [];
  const running = alive.filter((a) => a.status === 'RUNNING').length;
  const showError = error ?? actionError;

  return (
    <div className="panel agent-panel">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="section-title mb-0.5 flex items-center gap-2">
            <span className="agent-pulse-dot" aria-hidden />
            Agents
          </h3>
          <div className="text-[11px] text-[color:var(--text-3)]">
            Autonomous strategies running 24/7
          </div>
        </div>
        {loading && !agents ? (
          <Skeleton w={70} h={22} rounded="md" />
        ) : (
          <div className="flex items-center gap-2">
            <span className="chip">
              <span
                className="w-1.5 h-1.5 rounded-full"
                style={{ background: running > 0 ? 'var(--ok)' : 'var(--text-3)' }}
              />
              {running} running
            </span>
            {alive.length > running && (
              <span className="chip" style={{ opacity: 0.6 }}>
                {alive.length - running} paused
              </span>
            )}
          </div>
        )}
      </div>

      {loading && !agents ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="agent-card agent-card--skeleton">
              <div className="flex items-center gap-3 flex-1">
                <Skeleton w={36} h={36} rounded="lg" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton w="50%" h={13} />
                  <Skeleton w="70%" h={10} />
                </div>
              </div>
              <Skeleton w={76} h={26} rounded="md" />
            </div>
          ))}
        </div>
      ) : showError ? (
        <p className="text-[13px] text-[color:var(--bad)]">{showError}</p>
      ) : !agents || agents.length === 0 ? (
        <div className="agent-empty">
          <div className="text-[28px] mb-2 opacity-60">🤖</div>
          <div className="text-[13px] font-medium">No agents yet</div>
          <div className="text-[11px] text-[color:var(--text-3)] mt-1 max-w-sm">
            Ask QWAI to set up a DCA, stop-loss, or copy-trade — the agent
            will show up here and run autonomously.
          </div>
        </div>
      ) : (
        <div className="agent-list fade-in">
          {agents.map((a) => {
            const meta = KIND_META[a.kind];
            const expanded = expandedId === a.id;
            const p = a.params ?? {};
            return (
              <div
                key={a.id}
                className={`agent-card ${a.status === 'RUNNING' ? 'agent-card--running' : ''} ${a.status === 'KILLED' ? 'agent-card--killed' : ''} ${expanded ? 'agent-card--expanded' : ''}`}
                style={{ '--agent-color': meta.color } as React.CSSProperties}
              >
                <div
                  className="agent-card__main"
                  onClick={() => setExpandedId(expanded ? null : a.id)}
                  role="button"
                  tabIndex={0}
                >
                  {/* Icon */}
                  <div className="agent-card__icon">
                    {meta.icon}
                    {a.status === 'RUNNING' && (
                      <span className="agent-card__live-ring" />
                    )}
                  </div>

                  {/* Info */}
                  <div className="agent-card__info">
                    <div className="agent-card__title">
                      <span className="font-medium">{meta.label}</span>
                      {tokenLabel(p) && (
                        <span className="agent-card__pair">{tokenLabel(p)}</span>
                      )}
                    </div>
                    <div className="agent-card__subtitle">
                      <StatusBadge status={a.status} />
                      {strategyLine(a.kind, p)}
                      {a.lastRunAt && (
                        <>
                          <span className="agent-card__dot">·</span>
                          <span>ran {timeAgo(a.lastRunAt)}</span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Actions + chevron */}
                  <div className="agent-card__right">
                    <AgentActions agent={a} busy={busyId === a.id} onAction={act} />
                    <span className={`agent-card__chev ${expanded ? 'agent-card__chev--open' : ''}`}>›</span>
                  </div>
                </div>

                {/* Expanded detail with tabs */}
                {expanded && (
                  <AgentDetailPanel agent={a} meta={meta} />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: AgentStatus }) {
  const color =
    status === 'RUNNING' ? 'var(--ok)' : status === 'PAUSED' ? 'var(--warn)' : 'var(--text-3)';
  return (
    <span className="agent-status-badge" style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
      {status.toLowerCase()}
    </span>
  );
}

function AgentActions({
  agent,
  busy,
  onAction,
}: {
  agent: Agent;
  busy: boolean;
  onAction: (a: Agent, action: 'pause' | 'resume' | 'kill') => void;
}) {
  if (agent.status === 'KILLED') {
    return <span className="agent-status-badge" style={{ color: 'var(--text-3)', opacity: 0.5 }}>killed</span>;
  }
  return (
    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
      {agent.status === 'RUNNING' ? (
        <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => onAction(agent, 'pause')} title="Pause">
          ⏸
        </button>
      ) : (
        <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => onAction(agent, 'resume')} title="Resume">
          ▶
        </button>
      )}
      <button
        className="btn btn-sm btn-ghost"
        style={{ color: 'var(--bad)' }}
        disabled={busy}
        onClick={() => onAction(agent, 'kill')}
        title="Kill agent"
      >
        ✕
      </button>
    </div>
  );
}

type DetailTab = 'activity' | 'config';

function AgentDetailPanel({ agent, meta }: { agent: Agent; meta: typeof KIND_META[AgentKind] }) {
  const [tab, setTab] = useState<DetailTab>('activity');
  const p = agent.params ?? {};

  return (
    <div className="agent-card__detail" onClick={(e) => e.stopPropagation()}>
      {/* Mini tab bar */}
      <div className="flex gap-1 mb-3">
        {(['activity', 'config'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className="px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors"
            style={
              tab === t
                ? { background: 'var(--surface)', color: 'var(--text)', boxShadow: '0 1px 2px rgba(0,0,0,0.12)' }
                : { color: 'var(--text-3)' }
            }
          >
            {t === 'activity' ? 'Live Activity' : 'Config'}
          </button>
        ))}
      </div>

      {tab === 'activity' ? (
        <AgentActivityLog agentId={agent.id} />
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-3">
          <DetailField label="Agent ID" value={agent.id} mono />
          <DetailField label="Kind" value={meta.label} />
          <DetailField label="Status" value={agent.status} />
          <DetailField label="Chain" value={p.chain ?? '—'} />
          {p.tokenIn && <DetailField label="Token In" value={shortAddr(p.tokenIn)} mono />}
          {p.tokenOut && <DetailField label="Token Out" value={shortAddr(p.tokenOut)} mono />}
          {p.amountUsd != null && <DetailField label="Amount" value={`$${p.amountUsd}`} />}
          {p.interval && <DetailField label="Interval" value={p.interval} />}
          {p.stopPrice != null && <DetailField label="Stop Price" value={`$${p.stopPrice}`} />}
          {p.slippageBps != null && <DetailField label="Slippage" value={`${p.slippageBps} bps`} />}
          {p.srcWallet && <DetailField label="Copy Wallet" value={shortAddr(p.srcWallet)} mono />}
          <DetailField label="Created" value={new Date(agent.createdAt).toLocaleString()} />
          {agent.lastRunAt && <DetailField label="Last Run" value={new Date(agent.lastRunAt).toLocaleString()} />}
        </div>
      )}
    </div>
  );
}

interface LogEntry {
  id: string;
  kind: string;
  severity: 'INFO' | 'WARN' | 'CRITICAL';
  payload: Record<string, any>;
  createdAt: string;
}

function AgentActivityLog({ agentId }: { agentId: string }) {
  const [logs, setLogs] = useState<LogEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      api.get<LogEntry[]>(`/alerts/agent-log?agentId=${agentId}&limit=20`)
        .then((r) => { if (!cancelled) setLogs(Array.isArray(r.data) ? r.data : []); })
        .catch((e) => { if (!cancelled) setErr(e?.message ?? 'Failed to load'); });
    };
    load();
    const interval = setInterval(load, 15_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [agentId]);

  if (err) return <div className="text-[12px] text-[color:var(--bad)]">{err}</div>;
  if (!logs) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex gap-3 items-start">
            <Skeleton w={6} h={6} rounded="full" />
            <div className="flex-1 space-y-1"><Skeleton w="80%" h={10} /><Skeleton w="50%" h={9} /></div>
          </div>
        ))}
      </div>
    );
  }
  if (logs.length === 0) {
    return (
      <div className="text-[12px] text-[color:var(--text-3)] py-4 text-center">
        No activity yet — agent will log events as it runs.
      </div>
    );
  }

  return (
    <div className="agent-log">
      {logs.map((log, i) => {
        const sevColor = log.severity === 'CRITICAL' ? 'var(--bad)' : log.severity === 'WARN' ? 'var(--warn)' : 'var(--ok)';
        const msg = log.payload?.message ?? prettyKind(log.kind);
        const isLast = i === logs.length - 1;
        return (
          <div key={log.id} className="agent-log__entry">
            <div className="agent-log__timeline">
              <span className="agent-log__dot" style={{ background: sevColor, boxShadow: `0 0 0 3px color-mix(in srgb, ${sevColor} 18%, transparent)` }} />
              {!isLast && <span className="agent-log__line" />}
            </div>
            <div className="agent-log__content">
              <div className="agent-log__msg">{msg}</div>
              <div className="agent-log__time">
                <span className="agent-log__kind">{prettyKind(log.kind)}</span>
                <span>·</span>
                <span>{timeAgo(log.createdAt)}</span>
                {log.payload?.currentPrice != null && (
                  <>
                    <span>·</span>
                    <span className="font-mono">${Number(log.payload.currentPrice).toFixed(4)}</span>
                  </>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function prettyKind(k: string): string {
  return k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function DetailField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-[color:var(--text-3)]">{label}</div>
      <div className={`text-[12px] ${mono ? 'font-mono' : ''} truncate`} title={value}>{value}</div>
    </div>
  );
}

function tokenLabel(p: AgentParams): string | null {
  if (!p.tokenIn && !p.tokenOut) return null;
  const inSym = shortAddr(p.tokenIn ?? '');
  const outSym = shortAddr(p.tokenOut ?? '');
  if (inSym && outSym) return `${inSym} → ${outSym}`;
  return outSym || inSym || null;
}

function strategyLine(kind: AgentKind, p: AgentParams): React.ReactNode {
  const parts: string[] = [];
  if (kind === 'DCA' && p.amountUsd) {
    parts.push(`$${p.amountUsd}/${p.interval ?? 'daily'}`);
  }
  if (kind === 'STOP_LOSS' && p.stopPrice) {
    parts.push(`trigger @ $${p.stopPrice}`);
  }
  if (kind === 'COPY_TRADE' && p.srcWallet) {
    parts.push(`copying ${shortAddr(p.srcWallet)}`);
  }
  if (p.chain) parts.push(p.chain);
  if (!parts.length) return null;
  return (
    <>
      <span className="agent-card__dot">·</span>
      <span className="font-mono text-[10.5px]">{parts.join(' · ')}</span>
    </>
  );
}

function shortAddr(s: string): string {
  if (!s) return '';
  if (s.length <= 10) return s;
  return s.slice(0, 4) + '…' + s.slice(-4);
}

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
