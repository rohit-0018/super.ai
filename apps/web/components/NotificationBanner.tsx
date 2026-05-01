'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRealtime } from '../lib/useRealtime';
import { api } from '../lib/api';
import { invalidate } from '../lib/useApi';

interface Toast {
  id: string;
  kind: string;
  severity: 'INFO' | 'WARN' | 'CRITICAL';
  payload: Record<string, any>;
  at: number;
}

const DURATION = 6000;
const MAX_VISIBLE = 4;

export default function NotificationBanner() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  useRealtime('alert', (data: any) => {
    const toast: Toast = {
      id: data.id ?? String(Date.now()),
      kind: data.kind ?? 'notification',
      severity: data.severity ?? 'INFO',
      payload: data.payload ?? {},
      at: Date.now(),
    };
    setToasts((prev) => [...prev.slice(-(MAX_VISIBLE - 1)), toast]);
    // Invalidate API caches so bell + unread count update
    invalidate('/alerts?limit=15');
    invalidate('/alerts/unread-count');
  });

  return (
    <div
      aria-live="polite"
      style={{
        position: 'fixed',
        top: 52,
        right: 16,
        zIndex: 9000,
        display: 'flex',
        flexDirection: 'column-reverse',
        gap: 8,
        pointerEvents: 'none',
      }}
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const progressRef = useRef<HTMLDivElement>(null);
  const startRef = useRef(Date.now());

  // Auto-dismiss
  useEffect(() => {
    const id = setTimeout(onDismiss, DURATION);
    return () => clearTimeout(id);
  }, [onDismiss]);

  // Progress bar animation
  useEffect(() => {
    const el = progressRef.current;
    if (!el) return;
    const elapsed = Date.now() - startRef.current;
    const remaining = Math.max(0, DURATION - elapsed);
    el.style.transition = 'none';
    el.style.width = '100%';
    requestAnimationFrame(() => {
      el.style.transition = `width ${remaining}ms linear`;
      el.style.width = '0%';
    });
  }, []);

  const { color, bg, icon } = severityStyle(toast.severity);
  const title = toast.kind.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const body = extractBody(toast.payload);

  return (
    <div
      className="fade-in"
      style={{
        pointerEvents: 'auto',
        width: 340,
        background: 'var(--surface)',
        border: `1px solid ${bg}`,
        borderRadius: 10,
        boxShadow: `0 4px 24px rgba(0,0,0,0.4), inset 0 1px 0 var(--highlight)`,
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 14px 10px' }}>
        {/* Severity icon */}
        <span style={{
          fontSize: 16,
          lineHeight: 1,
          marginTop: 1,
          flexShrink: 0,
        }}>
          {icon}
        </span>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--text)',
            marginBottom: body ? 2 : 0,
            lineHeight: '16px',
          }}>
            {title}
          </div>
          {body && (
            <div style={{
              fontSize: 11.5,
              color: 'var(--text-2)',
              lineHeight: '15px',
              overflow: 'hidden',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
            }}>
              {body}
            </div>
          )}
        </div>

        <button
          onClick={onDismiss}
          style={{
            flexShrink: 0,
            width: 20,
            height: 20,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 4,
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--text-3)',
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      {/* Progress bar */}
      <div style={{ height: 2, background: 'rgba(255,255,255,0.06)' }}>
        <div
          ref={progressRef}
          style={{ height: '100%', background: color, width: '100%', borderRadius: 1 }}
        />
      </div>
    </div>
  );
}

function severityStyle(s: Toast['severity']) {
  switch (s) {
    case 'CRITICAL': return { color: 'var(--bad)',  bg: 'rgba(239,68,68,0.25)',   icon: '🚨' };
    case 'WARN':     return { color: 'var(--warn)', bg: 'rgba(245,158,11,0.25)',  icon: '⚠️' };
    default:         return { color: 'var(--accent)', bg: 'rgba(59,130,246,0.20)', icon: '💡' };
  }
}

function extractBody(payload: Record<string, any>): string {
  if (!payload) return '';
  if (typeof payload.message === 'string') return payload.message.slice(0, 120);
  if (typeof payload.summary === 'string') return payload.summary.slice(0, 120);
  if (typeof payload.reason === 'string')  return payload.reason.slice(0, 120);
  const entries = Object.entries(payload)
    .filter(([k]) => !['traceId', 'userId', 'id'].includes(k))
    .slice(0, 2);
  return entries.map(([k, v]) => `${k}: ${typeof v === 'object' ? '' : String(v).slice(0, 40)}`).join(' · ');
}
