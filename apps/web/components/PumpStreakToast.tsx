'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useRealtime } from '../lib/useRealtime';

interface StreakWinner {
  address: string;
  symbol: string;
  priceUsd: number;
  priceChange1h: number;
  score: number;
  count: number;
  firstSeenAt: string;
  profileKey: string;
}

interface ToastEntry {
  id: string;
  winners: StreakWinner[];
  ts: number;
  exiting: boolean;
}

const AUTO_DISMISS_MS = 9_000;

export default function PumpStreakToast() {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const timerMap = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    setToasts((prev) =>
      prev.map((t) => (t.id === id ? { ...t, exiting: true } : t)),
    );
    // Remove after exit animation
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 400);
    const timer = timerMap.current.get(id);
    if (timer) { clearTimeout(timer); timerMap.current.delete(id); }
  }, []);

  const addToast = useCallback((winners: StreakWinner[], scannedAt: string) => {
    const id = `${scannedAt}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts((prev) => [...prev.slice(-2), { id, winners, ts: Date.now(), exiting: false }]);
    const timer = setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
    timerMap.current.set(id, timer);
  }, [dismiss]);

  useRealtime('pump_streak', (data: { winners: StreakWinner[]; scannedAt: string }) => {
    if (data?.winners?.length) addToast(data.winners, data.scannedAt);
  });

  useEffect(() => {
    return () => {
      for (const t of timerMap.current.values()) clearTimeout(t);
    };
  }, []);

  if (!toasts.length) return null;

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 24,
        right: 20,
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        alignItems: 'flex-end',
        pointerEvents: 'none',
      }}
    >
      {toasts.map((toast) => (
        <GooCard key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
      ))}
    </div>
  );
}

function GooCard({ toast, onDismiss }: { toast: ToastEntry; onDismiss: () => void }) {
  const top = toast.winners[0];
  const extra = toast.winners.length - 1;
  const isUp = top.priceChange1h >= 0;
  const changeStr = `${isUp ? '+' : ''}${top.priceChange1h.toFixed(1)}%`;

  return (
    <>
      <style>{`
        @keyframes goo-in {
          0% { transform: scale(0.6) translateY(40px); opacity: 0; filter: blur(6px); }
          60% { transform: scale(1.05) translateY(-4px); opacity: 1; filter: blur(0); }
          100% { transform: scale(1) translateY(0); opacity: 1; filter: blur(0); }
        }
        @keyframes goo-out {
          0% { transform: scale(1); opacity: 1; }
          100% { transform: scale(0.7) translateY(20px); opacity: 0; filter: blur(4px); }
        }
        @keyframes goo-pulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(168, 85, 247, 0.4), 0 8px 32px rgba(0,0,0,0.5); }
          50% { box-shadow: 0 0 0 8px rgba(168, 85, 247, 0.0), 0 8px 32px rgba(0,0,0,0.5); }
        }
        @keyframes goo-streak-fire {
          0%, 100% { opacity: 0.7; transform: scaleY(1); }
          50% { opacity: 1; transform: scaleY(1.15); }
        }
      `}</style>
      <div
        style={{
          pointerEvents: 'all',
          animation: toast.exiting
            ? 'goo-out 0.35s cubic-bezier(0.4,0,0.2,1) forwards'
            : 'goo-in 0.5s cubic-bezier(0.34,1.56,0.64,1) forwards, goo-pulse 2s ease-in-out 0.5s infinite',
          background: 'linear-gradient(135deg, rgba(30,20,50,0.97) 0%, rgba(15,10,30,0.98) 100%)',
          border: '1px solid rgba(168,85,247,0.5)',
          borderRadius: 16,
          padding: '12px 14px',
          minWidth: 220,
          maxWidth: 280,
          backdropFilter: 'blur(20px)',
          cursor: 'pointer',
          position: 'relative',
          overflow: 'hidden',
        }}
        onClick={() => {
          window.location.href = `/intel?address=${top.address}`;
        }}
      >
        {/* Goo blob background decoration */}
        <div
          style={{
            position: 'absolute',
            top: -30,
            right: -30,
            width: 100,
            height: 100,
            borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(168,85,247,0.25) 0%, transparent 70%)',
            animation: 'goo-streak-fire 1.8s ease-in-out infinite',
            pointerEvents: 'none',
          }}
        />

        {/* Dismiss button */}
        <button
          onClick={(e) => { e.stopPropagation(); onDismiss(); }}
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            background: 'none',
            border: 'none',
            color: 'rgba(255,255,255,0.35)',
            fontSize: 13,
            cursor: 'pointer',
            padding: '2px 5px',
            lineHeight: 1,
            borderRadius: 4,
          }}
        >
          ✕
        </button>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 18 }}>🔥</span>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', color: 'rgba(168,85,247,0.9)', textTransform: 'uppercase' }}>
            Pump streak detected
          </span>
        </div>

        {/* Token row */}
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 18, color: '#fff', letterSpacing: '-0.02em' }}>
            {top.symbol}
          </span>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 15,
              fontWeight: 700,
              color: isUp ? 'var(--ok, #22c55e)' : 'var(--bad, #ef4444)',
            }}
          >
            {changeStr} 1h
          </span>
        </div>

        {/* Streak count + score */}
        <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            style={{
              fontSize: 11,
              background: 'rgba(168,85,247,0.2)',
              border: '1px solid rgba(168,85,247,0.35)',
              color: 'rgba(200,160,255,0.9)',
              borderRadius: 6,
              padding: '2px 7px',
              fontFamily: 'var(--font-mono)',
            }}
          >
            ×{top.count} scans
          </span>
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', fontFamily: 'var(--font-mono)' }}>
            score <b style={{ color: 'rgba(255,255,255,0.8)' }}>{top.score}</b>/100
          </span>
        </div>

        {/* CA */}
        <div
          style={{
            marginTop: 6,
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: 'rgba(255,255,255,0.3)',
            letterSpacing: '0.02em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {top.address}
        </div>

        {extra > 0 && (
          <div style={{ marginTop: 6, fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>
            +{extra} more token{extra > 1 ? 's' : ''} pumping
          </div>
        )}

        {/* QWAI badge */}
        <div
          style={{
            marginTop: 8,
            fontSize: 10,
            color: 'rgba(168,85,247,0.6)',
            letterSpacing: '0.06em',
            fontWeight: 600,
          }}
        >
          QWAI intel · tap to analyze
        </div>

        {/* Progress bar for auto-dismiss */}
        <ProgressBar durationMs={AUTO_DISMISS_MS} />
      </div>
    </>
  );
}

function ProgressBar({ durationMs }: { durationMs: number }) {
  const [pct, setPct] = useState(100);
  const startRef = useRef(Date.now());

  useEffect(() => {
    const tick = () => {
      const elapsed = Date.now() - startRef.current;
      const remaining = Math.max(0, 100 - (elapsed / durationMs) * 100);
      setPct(remaining);
      if (remaining > 0) requestAnimationFrame(tick);
    };
    const raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [durationMs]);

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        height: 2,
        width: `${pct}%`,
        background: 'linear-gradient(90deg, rgba(168,85,247,0.7), rgba(168,85,247,0.3))',
        transition: 'none',
        borderRadius: '0 0 0 16px',
      }}
    />
  );
}
