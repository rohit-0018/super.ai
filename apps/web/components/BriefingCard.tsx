'use client';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Skeleton, SkeletonText } from './ui/Skeleton';

interface Briefing {
  id: string;
  createdAt: string;
  payload: {
    window?: string;
    tradesCount?: number;
    filledOrders?: number;
    alertsCount?: number;
    pnlUsd?: number;
    volumeUsd?: number;
    summary?: string;
  };
}

export default function BriefingCard() {
  const [briefing, setBriefing] = useState<Briefing | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    api
      .get<Briefing | null>('/alerts/briefings/latest')
      .then((r) => { if (!cancelled) setBriefing(r.data); })
      .catch(() => { if (!cancelled) setBriefing(null); });
    return () => { cancelled = true; };
  }, []);

  const loading = briefing === undefined;
  const p = briefing?.payload;

  return (
    <div
      className="panel glass-sheen relative overflow-hidden"
      style={{
        background:
          'linear-gradient(135deg, color-mix(in srgb, var(--accent) 8%, var(--surface)) 0%, var(--surface) 60%)',
      }}
    >
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2.5">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center text-[14px]"
            style={{
              background: 'color-mix(in srgb, var(--accent) 15%, var(--surface-2))',
              color: 'var(--accent)',
              border: '1px solid color-mix(in srgb, var(--accent) 35%, var(--border))',
            }}
          >
            ☼
          </div>
          <div>
            <div className="text-[13px] font-semibold">Morning briefing</div>
            <div className="text-[10.5px] text-[color:var(--text-3)]">
              {loading ? 'Loading…' : briefing?.createdAt ? new Date(briefing.createdAt).toLocaleString() : 'No briefing yet'}
            </div>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="space-y-4">
          <div className="grid grid-cols-4 gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="space-y-1.5">
                <Skeleton w="70%" h={10} />
                <Skeleton w="50%" h={16} />
              </div>
            ))}
          </div>
          <SkeletonText lines={2} />
        </div>
      ) : !briefing ? (
        <div className="py-6 text-center">
          <div className="text-[12.5px] text-[color:var(--text-3)] mb-1">
            Your first briefing runs tomorrow at 08:00 local time.
          </div>
          <div className="text-[11px] text-[color:var(--text-3)]">
            Overnight P&L, filled orders, risk flags — delivered here and to Telegram.
          </div>
        </div>
      ) : (
        <div className="fade-in">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <MiniStat label="P&L" value={p?.pnlUsd != null ? fmtUsd(p.pnlUsd) : '—'} accent={p?.pnlUsd != null ? (p.pnlUsd >= 0 ? 'var(--ok)' : 'var(--bad)') : undefined} />
            <MiniStat label="Trades" value={p?.tradesCount?.toString() ?? '0'} />
            <MiniStat label="Filled" value={p?.filledOrders?.toString() ?? '0'} />
            <MiniStat label="Alerts" value={p?.alertsCount?.toString() ?? '0'} />
          </div>
          {p?.summary && (
            <p className="text-[12.5px] text-[color:var(--text-2)] leading-relaxed">
              {p.summary}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function MiniStat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div>
      <div className="stat-label mb-1">{label}</div>
      <div className="font-mono text-[15px] font-semibold" style={{ color: accent ?? 'var(--text)' }}>
        {value}
      </div>
    </div>
  );
}

function fmtUsd(n: number): string {
  const sign = n < 0 ? '-' : n > 0 ? '+' : '';
  return `${sign}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}
