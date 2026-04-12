'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Skeleton } from './ui/Skeleton';

type AgentKind = 'DCA' | 'STOP_LOSS' | 'COPY_TRADE' | 'POSITION_MONITOR' | 'SNIPE' | 'BRIEFING';
type AgentStatus = 'RUNNING' | 'PAUSED' | 'KILLED';

interface Agent {
  id: string;
  kind: AgentKind;
  status: AgentStatus;
  params: Record<string, unknown>;
  lastRunAt?: string | null;
  createdAt: string;
}

const KIND_LABEL: Record<AgentKind, string> = {
  DCA: 'DCA',
  STOP_LOSS: 'Stop loss',
  COPY_TRADE: 'Copy trade',
  POSITION_MONITOR: 'Position monitor',
  SNIPE: 'Snipe',
  BRIEFING: 'Briefing',
};

const KIND_ICON: Record<AgentKind, string> = {
  DCA: '∑',
  STOP_LOSS: '⎯',
  COPY_TRADE: '⇌',
  POSITION_MONITOR: '◎',
  SNIPE: '⚡',
  BRIEFING: '☼',
};

export default function AgentsPanel() {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { data } = await api.get<Agent[]>('/agents');
      setAgents(Array.isArray(data) ? data : []);
      setError(null);
    } catch (e: any) {
      setAgents([]);
      setError(e?.message ?? 'Failed to load agents');
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 20_000);
    return () => clearInterval(id);
  }, [refresh]);

  async function act(agent: Agent, action: 'pause' | 'resume' | 'kill') {
    setBusyId(agent.id);
    try {
      if (action === 'kill') await api.delete(`/agents/${agent.id}`);
      else await api.post(`/agents/${agent.id}/${action}`, {});
      await refresh();
    } catch (e: any) {
      setError(e?.message ?? 'Action failed');
    } finally {
      setBusyId(null);
    }
  }

  const loading = agents === null;
  const running = agents?.filter((a) => a.status === 'RUNNING').length ?? 0;

  return (
    <div className="panel">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="section-title mb-0.5">Agents</h3>
          <div className="text-[11px] text-[color:var(--text-3)]">
            Autonomous trade logic running 24/7
          </div>
        </div>
        {loading ? (
          <Skeleton w={70} h={22} rounded="md" />
        ) : (
          <span className="chip">
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{ background: running > 0 ? 'var(--ok)' : 'var(--text-3)' }}
            />
            {running} running
          </span>
        )}
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between py-2.5">
              <div className="flex items-center gap-3 flex-1">
                <Skeleton w={28} h={28} rounded="md" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton w="40%" h={12} />
                  <Skeleton w="25%" h={10} />
                </div>
              </div>
              <Skeleton w={76} h={22} rounded="md" />
            </div>
          ))}
        </div>
      ) : error ? (
        <p className="text-[13px] text-[color:var(--bad)]">{error}</p>
      ) : agents!.length === 0 ? (
        <div className="py-6 text-center">
          <div className="text-[13px] text-[color:var(--text-3)] mb-2">No agents yet</div>
          <div className="text-[11px] text-[color:var(--text-3)] mb-3">
            Ask QWAI to set up a DCA, stop-loss, or copy-trade — the agent will
            show up here and run automatically.
          </div>
        </div>
      ) : (
        <ul className="fade-in divide-y divide-border -mx-2">
          {agents!.map((a) => (
            <li key={a.id} className="flex items-center justify-between px-2 py-3 gap-3">
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <div
                  className="w-8 h-8 rounded-md flex items-center justify-center text-[14px] shrink-0"
                  style={{
                    background: 'var(--surface-2)',
                    border: '1px solid var(--border)',
                    color: a.status === 'RUNNING' ? 'var(--accent)' : 'var(--text-3)',
                  }}
                >
                  {KIND_ICON[a.kind]}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium truncate">
                    {KIND_LABEL[a.kind]}
                    {typeof a.params?.symbol === 'string' ? (
                      <span className="text-[color:var(--text-3)] font-mono ml-1.5">
                        · {a.params.symbol as string}
                      </span>
                    ) : null}
                  </div>
                  <div className="text-[11px] text-[color:var(--text-3)] flex items-center gap-2">
                    <StatusDot status={a.status} />
                    {a.status.toLowerCase()}
                    {a.lastRunAt && (
                      <>
                        <span>·</span>
                        <span>last run {timeAgo(a.lastRunAt)}</span>
                      </>
                    )}
                  </div>
                </div>
              </div>
              <AgentActions agent={a} busy={busyId === a.id} onAction={act} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: AgentStatus }) {
  const c =
    status === 'RUNNING' ? 'var(--ok)' : status === 'PAUSED' ? 'var(--warn)' : 'var(--text-3)';
  return <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ background: c }} />;
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
    return <span className="chip">killed</span>;
  }
  return (
    <div className="flex items-center gap-1">
      {agent.status === 'RUNNING' ? (
        <button
          className="btn btn-sm btn-ghost"
          disabled={busy}
          onClick={() => onAction(agent, 'pause')}
          title="Pause"
        >
          Pause
        </button>
      ) : (
        <button
          className="btn btn-sm btn-ghost"
          disabled={busy}
          onClick={() => onAction(agent, 'resume')}
          title="Resume"
        >
          Resume
        </button>
      )}
      <button
        className="btn btn-sm btn-ghost"
        style={{ color: 'var(--bad)' }}
        disabled={busy}
        onClick={() => onAction(agent, 'kill')}
        title="Kill"
      >
        Kill
      </button>
    </div>
  );
}

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
