'use client';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Skeleton } from './ui/Skeleton';

interface Guardrails {
  perTradeUsd: number;
  dailyUsd: number;
  maxSlippageBps: number;
  whitelist: string[];
  blacklist: string[];
  killSwitch: boolean;
  dailySpentUsd?: number;
  tradesToday?: number;
}

export default function RiskMeter() {
  const [g, setG] = useState<Guardrails | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const { data } = await api.get<Guardrails>('/guardrails');
      setG(data);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load guardrails');
      setG(null);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function toggleKill() {
    if (!g) return;
    setBusy(true);
    try {
      await api.post('/guardrails', { ...g, killSwitch: !g.killSwitch });
      await load();
    } finally {
      setBusy(false);
    }
  }

  const loading = g === null && !error;

  const spent = g?.dailySpentUsd ?? 0;
  const cap = g?.dailyUsd ?? 1;
  const pct = Math.min(100, Math.round((spent / Math.max(1, cap)) * 100));

  return (
    <div className="panel">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="section-title mb-0.5">Risk · Guardrails</h3>
          <div className="text-[11px] text-[color:var(--text-3)]">
            Daily caps + kill switch protect every trade
          </div>
        </div>
        {loading ? (
          <Skeleton w={90} h={24} rounded="md" />
        ) : g ? (
          <button
            onClick={toggleKill}
            disabled={busy}
            className="btn btn-sm"
            style={
              g.killSwitch
                ? {
                    background: 'var(--bad)',
                    color: 'white',
                    borderColor: 'var(--bad)',
                  }
                : undefined
            }
            title={g.killSwitch ? 'Kill switch is ON — click to re-enable trading' : 'Click to halt all trades'}
          >
            {g.killSwitch ? '⏻ Trading halted' : 'Kill switch'}
          </button>
        ) : null}
      </div>

      {error && <p className="text-[13px] text-[color:var(--bad)] mb-3">{error}</p>}

      {/* Daily spend meter */}
      <div className="mb-4">
        <div className="flex items-baseline justify-between mb-1.5">
          <div className="stat-label">Daily spend</div>
          {loading ? (
            <Skeleton w={100} h={12} />
          ) : (
            <div className="text-[12px] font-mono text-[color:var(--text-2)]">
              ${spent.toLocaleString()} <span className="text-[color:var(--text-3)]">/ ${cap.toLocaleString()}</span>
            </div>
          )}
        </div>
        <div
          className="h-1.5 rounded-full overflow-hidden"
          style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}
        >
          {loading ? (
            <div className="skeleton h-full w-full" />
          ) : (
            <div
              className="h-full fade-in"
              style={{
                width: pct + '%',
                background:
                  pct > 85 ? 'var(--bad)' : pct > 60 ? 'var(--warn)' : 'var(--accent)',
                transition: 'width 400ms ease',
              }}
            />
          )}
        </div>
      </div>

      {/* Stat grid */}
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Per trade" value={loading ? null : `$${g!.perTradeUsd.toLocaleString()}`} />
        <Stat label="Max slip" value={loading ? null : `${(g!.maxSlippageBps / 100).toFixed(2)}%`} />
        <Stat label="Trades / day" value={loading ? null : `${g!.tradesToday ?? 0}`} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | null }) {
  return (
    <div
      className="px-3 py-2.5 rounded-lg"
      style={{
        background: 'var(--surface-2)',
        border: '1px solid var(--border)',
      }}
    >
      <div className="stat-label mb-1">{label}</div>
      {value === null ? (
        <Skeleton w="70%" h={14} />
      ) : (
        <div className="font-mono text-[13px] fade-in">{value}</div>
      )}
    </div>
  );
}
