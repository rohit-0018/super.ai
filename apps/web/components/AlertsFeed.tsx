'use client';
import { useApi } from '../lib/useApi';
import { Skeleton } from './ui/Skeleton';

interface Alert {
  id: string;
  kind: string;
  severity: 'INFO' | 'WARN' | 'CRITICAL';
  payload: Record<string, any>;
  createdAt: string;
}

export default function AlertsFeed() {
  // Deliberately identical key to NotificationBell so they share one fetch.
  const { data: allAlerts, loading, error } = useApi<Alert[]>('/alerts?limit=15', { pollMs: 30_000 });
  const alerts = (allAlerts ?? []).slice(0, 8);

  return (
    <div className="panel h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="section-title mb-0.5">Alerts & signals</h3>
          <div className="text-[11px] text-[color:var(--text-3)]">
            Pre-trade scans, agent events, and risk flags
          </div>
        </div>
        {!loading && allAlerts && (
          <span className="chip">{allAlerts.length}</span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto -mx-2 pr-2">
        {loading && !allAlerts ? (
          <ul className="space-y-3 px-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <li key={i} className="flex items-start gap-3">
                <Skeleton w={8} h={8} rounded="full" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton w="60%" h={12} />
                  <Skeleton w="85%" h={10} />
                </div>
              </li>
            ))}
          </ul>
        ) : error ? (
          <p className="text-[13px] text-[color:var(--bad)] px-2">{error}</p>
        ) : alerts.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center py-8">
            <div className="text-[20px] mb-2" style={{ color: 'var(--text-3)' }}>◦</div>
            <div className="text-[12.5px] text-[color:var(--text-3)]">No alerts yet</div>
            <div className="text-[11px] text-[color:var(--text-3)] mt-1">
              You'll see agent events and risk flags here
            </div>
          </div>
        ) : (
          <ul className="space-y-0 fade-in">
            {alerts.map((a) => (
              <li
                key={a.id}
                className="flex items-start gap-3 px-2 py-2.5 rounded-md hover:bg-[color:var(--surface-hover)] transition-colors"
              >
                <SeverityDot severity={a.severity} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[12.5px] font-medium truncate">
                      {prettyKind(a.kind)}
                    </div>
                    <div className="text-[10px] text-[color:var(--text-3)] shrink-0">
                      {timeAgo(a.createdAt)}
                    </div>
                  </div>
                  <div className="text-[11.5px] text-[color:var(--text-2)] line-clamp-2 mt-0.5">
                    {prettyPayload(a.payload)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function SeverityDot({ severity }: { severity: Alert['severity'] }) {
  const c = severity === 'CRITICAL' ? 'var(--bad)' : severity === 'WARN' ? 'var(--warn)' : 'var(--accent)';
  return (
    <span
      className="w-2 h-2 rounded-full mt-[7px] shrink-0"
      style={{ background: c, boxShadow: `0 0 0 3px color-mix(in srgb, ${c} 20%, transparent)` }}
    />
  );
}

function prettyKind(k: string) {
  return k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function prettyPayload(p: Record<string, any>): string {
  if (!p) return '';
  if (typeof p.message === 'string') return p.message;
  if (typeof p.summary === 'string') return p.summary;
  try {
    return Object.entries(p).slice(0, 2).map(([k, v]) => `${k}: ${String(v).slice(0, 40)}`).join(' · ');
  } catch { return ''; }
}

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
