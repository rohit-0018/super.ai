'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth-store';
import { Spinner } from './ui/Skeleton';

interface Alert {
  id: string;
  kind: string;
  severity: 'INFO' | 'WARN' | 'CRITICAL';
  payload: Record<string, any>;
  createdAt: string;
}

export default function NotificationBell() {
  const { accessToken, hydrated } = useAuth();
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get<Alert[]>('/alerts?limit=15');
      setAlerts(Array.isArray(data) ? data : []);
    } catch {
      setAlerts([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!hydrated || !accessToken) {
      setAlerts(null);
      return;
    }
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [hydrated, accessToken, load]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (!hydrated || !accessToken) return null;

  const unread = alerts?.length ?? 0;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative w-9 h-9 rounded-md flex items-center justify-center hover:bg-[color:var(--surface-hover)] transition-colors"
        aria-label="Notifications"
      >
        <BellIcon />
        {unread > 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 min-w-[16px] h-[16px] px-1 rounded-full flex items-center justify-center text-[10px] font-semibold leading-none"
            style={{
              background: 'var(--bad)',
              color: 'white',
              boxShadow: '0 0 0 2px var(--bg)',
            }}
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 top-[calc(100%+8px)] w-[360px] max-h-[520px] z-50 glass-strong overflow-hidden flex flex-col fade-in"
          style={{ boxShadow: '0 12px 40px rgba(0,0,0,0.4)' }}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-[color:var(--border)]">
            <div className="text-[13px] font-semibold">Notifications</div>
            {loading && <Spinner size={12} />}
          </div>
          <div className="overflow-y-auto flex-1">
            {alerts === null || (loading && alerts.length === 0) ? (
              <div className="px-4 py-8 text-center text-[12px] text-[color:var(--text-3)]">
                Loading…
              </div>
            ) : alerts.length === 0 ? (
              <div className="px-4 py-10 text-center">
                <div className="text-[20px] mb-2" style={{ color: 'var(--text-3)' }}>◦</div>
                <div className="text-[12px] text-[color:var(--text-3)]">No notifications yet</div>
              </div>
            ) : (
              <ul className="divide-y divide-[color:var(--border)]">
                {alerts.map((a) => (
                  <li key={a.id} className="px-4 py-3 hover:bg-[color:var(--surface-hover)]">
                    <div className="flex items-start gap-2.5">
                      <SeverityDot severity={a.severity} />
                      <div className="flex-1 min-w-0">
                        <div className="text-[12px] font-medium truncate">{prettyKind(a.kind)}</div>
                        <div className="text-[11.5px] text-[color:var(--text-2)] line-clamp-2 mt-0.5">
                          {prettyPayload(a.payload)}
                        </div>
                        <div className="text-[10.5px] text-[color:var(--text-3)] mt-1">
                          {timeAgo(a.createdAt)}
                        </div>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function BellIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

function SeverityDot({ severity }: { severity: Alert['severity'] }) {
  const c = severity === 'CRITICAL' ? 'var(--bad)' : severity === 'WARN' ? 'var(--warn)' : 'var(--accent)';
  return <span className="w-2 h-2 rounded-full mt-1.5 shrink-0" style={{ background: c }} />;
}

function prettyKind(k: string) {
  return k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function prettyPayload(p: Record<string, any>): string {
  if (!p) return '';
  if (typeof p.message === 'string') return p.message;
  if (typeof p.summary === 'string') return p.summary;
  try {
    const first = Object.entries(p)
      .slice(0, 3)
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
      .join(' · ');
    return first || '';
  } catch {
    return '';
  }
}

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
