'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useApi, invalidate } from '../lib/useApi';
import { useRealtime } from '../lib/useRealtime';
import { api } from '../lib/api';
import { Spinner } from './ui/Skeleton';

interface Alert {
  id: string;
  kind: string;
  severity: 'INFO' | 'WARN' | 'CRITICAL';
  payload: Record<string, any>;
  readAt: string | null;
  createdAt: string;
}

export default function NotificationBell() {
  const { data: alerts, loading } = useApi<Alert[]>('/alerts?limit=20');
  const { data: badge }           = useApi<{ count: number }>('/alerts/unread-count');
  const [open, setOpen]           = useState(false);
  const ref                       = useRef<HTMLDivElement>(null);

  // Real-time: refresh on new alert
  useRealtime('alert', () => {
    invalidate('/alerts?limit=20');
    invalidate('/alerts/unread-count');
  });

  // Click-outside close
  useEffect(() => {
    if (!open) return;
    const fn = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', fn);
    return () => document.removeEventListener('mousedown', fn);
  }, [open]);

  // Mark all read when panel opens
  const handleOpen = useCallback(async () => {
    setOpen((v) => {
      if (!v) {
        // Schedule mark-all-read after opening
        setTimeout(async () => {
          try {
            await api.post('/alerts/read-all');
            invalidate('/alerts?limit=20');
            invalidate('/alerts/unread-count');
          } catch { /* */ }
        }, 800);
      }
      return !v;
    });
  }, []);

  const unread = badge?.count ?? 0;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={handleOpen}
        className="relative flex items-center justify-center rounded-md hover:bg-[color:var(--surface-hover)] transition-colors"
        style={{ width: 36, height: 36 }}
        aria-label="Notifications"
      >
        <BellIcon hasNew={unread > 0} />
        {unread > 0 && (
          <span
            className="absolute flex items-center justify-center font-semibold leading-none"
            style={{
              top: -2,
              right: -2,
              minWidth: 16,
              height: 16,
              padding: '0 3px',
              borderRadius: 999,
              fontSize: 9.5,
              background: 'var(--bad)',
              color: '#fff',
              boxShadow: '0 0 0 2px var(--bg)',
            }}
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 z-50 flex flex-col overflow-hidden fade-in"
          style={{
            top: 'calc(100% + 8px)',
            width: 360,
            maxHeight: 520,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 12,
            boxShadow: 'inset 0 1px 0 var(--highlight), 0 16px 48px rgba(0,0,0,0.5)',
          }}
        >
          {/* Header */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 14px',
            borderBottom: '1px solid var(--border)',
            flexShrink: 0,
          }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Notifications</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {loading && <Spinner size={12} />}
              {unread > 0 && (
                <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{unread} unread</span>
              )}
              <button
                onClick={() => setOpen(false)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', padding: 2 }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
          </div>

          {/* List */}
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {loading && !alerts ? (
              <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--text-3)', fontSize: 12 }}>
                Loading…
              </div>
            ) : !alerts || alerts.length === 0 ? (
              <div style={{ padding: '40px 16px', textAlign: 'center' }}>
                <div style={{ fontSize: 28, marginBottom: 8, opacity: 0.3 }}>◦</div>
                <div style={{ fontSize: 12, color: 'var(--text-3)' }}>No notifications yet</div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>Events from your agents and trades appear here</div>
              </div>
            ) : (
              <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                {alerts.map((a, i) => (
                  <AlertRow key={a.id} alert={a} isLast={i === alerts.length - 1} />
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function AlertRow({ alert, isLast }: { alert: Alert; isLast: boolean }) {
  const isUnread = !alert.readAt;
  const { dotColor, icon } = severityMeta(alert.severity);

  return (
    <li style={{
      display: 'flex',
      alignItems: 'flex-start',
      gap: 10,
      padding: '10px 14px',
      borderBottom: isLast ? 'none' : '1px solid var(--border)',
      background: isUnread ? 'rgba(59,130,246,0.04)' : 'transparent',
      transition: 'background 120ms',
      cursor: 'default',
    }}>
      {/* Dot + icon */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, flexShrink: 0, marginTop: 2 }}>
        <span style={{ fontSize: 13, lineHeight: 1 }}>{icon}</span>
        {isUnread && (
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: dotColor }} />
        )}
      </div>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: isUnread ? 600 : 500, color: 'var(--text)', lineHeight: '16px' }}>
            {prettyKind(alert.kind)}
          </span>
          <span style={{ fontSize: 10.5, color: 'var(--text-3)', flexShrink: 0 }}>
            {timeAgo(alert.createdAt)}
          </span>
        </div>
        <div style={{
          fontSize: 11.5,
          color: 'var(--text-2)',
          marginTop: 2,
          lineHeight: '15px',
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
        }}>
          {prettyPayload(alert.payload)}
        </div>
      </div>
    </li>
  );
}

function BellIcon({ hasNew }: { hasNew: boolean }) {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none"
      stroke={hasNew ? 'var(--accent)' : 'currentColor'}
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
    >
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      {hasNew && <circle cx="18" cy="5" r="3" fill="var(--bad)" stroke="var(--bg)" strokeWidth="1.5" />}
    </svg>
  );
}

function severityMeta(s: Alert['severity']) {
  switch (s) {
    case 'CRITICAL': return { dotColor: 'var(--bad)',  icon: '🚨' };
    case 'WARN':     return { dotColor: 'var(--warn)', icon: '⚠️' };
    default:         return { dotColor: 'var(--accent)', icon: '💡' };
  }
}

function prettyKind(k: string): string {
  return k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function prettyPayload(p: Record<string, any>): string {
  if (!p) return '';
  if (typeof p.message === 'string') return p.message.slice(0, 120);
  if (typeof p.summary === 'string') return p.summary.slice(0, 120);
  if (typeof p.reason === 'string')  return p.reason.slice(0, 120);
  const entries = Object.entries(p)
    .filter(([k]) => !['traceId', 'userId'].includes(k))
    .slice(0, 3);
  return entries.map(([k, v]) => `${k}: ${typeof v === 'object' ? '…' : String(v).slice(0, 40)}`).join(' · ');
}

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60)    return `${Math.round(s)}s ago`;
  if (s < 3600)  return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
