'use client';
import { useEffect, useRef, useState } from 'react';
import { useRealtime, emitLocal } from '../lib/useRealtime';
import { useApi } from '../lib/useApi';
import { fmtPriceUsd } from '../lib/format-price';
import type { SignalResult } from './SignalBanner';

const VERDICT_COLOR: Record<string, string> = {
  STRONG_BUY: '#22c55e',
  BUY:        '#4ade80',
  CAUTIOUS:   '#f59e0b',
  SKIP:       '#8a8fa3',
  HIGH_RISK:  '#ef4444',
};

const VERDICT_LABEL: Record<string, string> = {
  STRONG_BUY: 'STRONG BUY',
  BUY:        'BUY',
  CAUTIOUS:   'CAUTIOUS',
  SKIP:       'SKIP',
  HIGH_RISK:  'HIGH RISK',
};

function fireTestSignal() {
  const mock: SignalResult = {
    address:        'So11111111111111111111111111111111111111112',
    symbol:         'TEST',
    name:           'Test Token',
    chain:          'SOLANA',
    priceUsd:       0.00042,
    score:          88,
    verdict:        'STRONG_BUY',
    profileKey:     'meme_hunter',
    entryPriceUsd:  0.00042,
    t1PriceUsd:     0.00058,
    t1Pct:          38,
    t2PriceUsd:     0.00075,
    t2Pct:          79,
    stopLossPriceUsd: 0.00034,
    stopLossPct:    19,
    holdRange:      '2–6h',
    riskReward:     2.8,
    bullishSignals: ['Volume spike 12x', 'Smart money accumulation', 'Unique traders rising'],
    riskFactors:    ['Low liquidity', 'New token <24h old'],
    aiSummary:      'Test signal — strong momentum with rising volume and smart wallet inflows.',
    exitSizing:     'Take 50% at T1, trail stop for remainder',
    analyzedAt:     new Date().toISOString(),
    dexUrl:         'https://dexscreener.com',
  };
  emitLocal('signal_alert', mock);
}

export default function SignalQueuePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [results, setResults] = useState<SignalResult[]>([]);
  const [analyzing, setAnalyzing] = useState<string | null>(null);
  const { data: fetched } = useApi<SignalResult[]>('/hot-tokens/signals', { pollMs: open ? 5_000 : 0 });

  useEffect(() => {
    if (fetched) setResults(fetched);
  }, [fetched]);

  useRealtime('signal_analysis', (data: SignalResult) => {
    setAnalyzing(null);
    setResults((prev) => {
      const next = prev.filter((r) => r.address !== data.address);
      return [data, ...next].slice(0, 30);
    });
  });

  // Show which token is currently being analyzed (updated from hot_tokens_update)
  useRealtime('hot_tokens_update', () => {
    // Just a pulse — actual token name comes from signal_analysis when done
  });

  const strongBuys = results.filter((r) => r.score >= 78);
  const others     = results.filter((r) => r.score < 78);

  return (
    <>
      {/* Backdrop (mobile) */}
      {open && (
        <div
          className="show-mobile"
          onClick={onClose}
          style={{ position: 'fixed', inset: 0, zIndex: 28, background: 'rgba(0,0,0,0.5)' }}
        />
      )}

      <aside
        style={{
          position: 'fixed',
          left: open ? 56 : -300,
          top: 0,
          bottom: 0,
          width: 280,
          background: 'var(--surface)',
          borderRight: '1px solid var(--border)',
          zIndex: 29,
          transition: 'left 0.2s ease',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: open ? '12px 0 32px rgba(0,0,0,0.3)' : 'none',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '14px 12px 10px',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.08em', color: 'var(--text)' }}>
                SIGNAL QUEUE
              </span>
              {strongBuys.length > 0 && (
                <span style={{
                  background: '#22c55e', color: '#fff', borderRadius: 10,
                  fontSize: 9, fontWeight: 800, padding: '1px 6px', letterSpacing: '0.05em',
                }}>
                  {strongBuys.length} STRONG
                </span>
              )}
            </div>
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', fontSize: 18, lineHeight: 1 }}>×</button>
          </div>

          {/* Pipeline status */}
          <PipelineStatus analyzing={analyzing} total={results.length} />
        </div>

        {/* Results */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
          {results.length === 0 ? (
            <div style={{ padding: '24px 16px', textAlign: 'center' }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>⏳</div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', lineHeight: 1.5 }}>
                Pipeline is analyzing hot tokens.<br />Results appear here in real-time.
              </div>
            </div>
          ) : (
            <>
              {strongBuys.length > 0 && (
                <div>
                  <SectionLabel>Strong signals</SectionLabel>
                  {strongBuys.map((r) => <ResultRow key={r.address} result={r} />)}
                </div>
              )}
              {others.length > 0 && (
                <div>
                  <SectionLabel>{strongBuys.length > 0 ? 'Other signals' : 'All signals'}</SectionLabel>
                  {others.map((r) => <ResultRow key={r.address} result={r} />)}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer: test button */}
        <div style={{
          padding: '10px 12px',
          borderTop: '1px solid var(--border)',
          flexShrink: 0,
          display: 'flex',
          gap: 8,
        }}>
          <button
            onClick={fireTestSignal}
            style={{
              flex: 1,
              padding: '6px 10px',
              background: 'color-mix(in srgb, #22c55e 12%, var(--surface-2))',
              border: '1px solid color-mix(in srgb, #22c55e 30%, var(--border))',
              borderRadius: 6,
              color: '#22c55e',
              fontSize: 11,
              fontWeight: 700,
              cursor: 'pointer',
              letterSpacing: '0.06em',
            }}
          >
            ⚡ FIRE TEST BANNER
          </button>
        </div>
      </aside>
    </>
  );
}

function PipelineStatus({ analyzing, total }: { analyzing: string | null; total: number }) {
  const [dot, setDot] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => {
    timer.current = setInterval(() => setDot((d) => (d + 1) % 3), 500);
    return () => clearInterval(timer.current);
  }, []);

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '5px 8px', borderRadius: 6,
      background: 'var(--surface-2)', border: '1px solid var(--border)',
    }}>
      <span style={{
        width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
        background: '#22c55e',
        boxShadow: '0 0 6px #22c55e',
        animation: 'pipeline-pulse 1.5s ease-in-out infinite',
      }} />
      <style>{`@keyframes pipeline-pulse { 0%,100% { opacity:1 } 50% { opacity:0.4 } }`}</style>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-2)' }}>
          {analyzing
            ? `Analyzing ${analyzing}${'.'.repeat(dot + 1)}`
            : total > 0
            ? `${total} tokens analyzed`
            : 'Pipeline running'}
        </div>
        <div style={{ fontSize: 9, color: 'var(--text-3)' }}>
          AI scores updating in real-time
        </div>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div style={{
      padding: '6px 14px 3px',
      fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
      color: 'var(--text-3)', textTransform: 'uppercase',
    }}>
      {children}
    </div>
  );
}

function ResultRow({ result }: { result: SignalResult }) {
  const color = VERDICT_COLOR[result.verdict] ?? '#8a8fa3';
  const ago   = getAgo(result.analyzedAt);

  return (
    <div style={{
      padding: '7px 14px',
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      borderBottom: '1px solid color-mix(in srgb, var(--border) 50%, transparent)',
      cursor: 'default',
      transition: 'background 120ms',
    }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-2)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = '')}
    >
      {/* Score circle */}
      <div style={{
        width: 34, height: 34, borderRadius: '50%', flexShrink: 0,
        border: `2px solid ${color}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: `color-mix(in srgb, ${color} 10%, transparent)`,
      }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 800, color }}>
          {result.score}
        </span>
      </div>

      {/* Info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>
            {result.symbol}
          </span>
          <span style={{ fontSize: 9, fontWeight: 600, color, letterSpacing: '0.06em' }}>
            {VERDICT_LABEL[result.verdict]}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-3)' }}>
            {fmtPriceUsd(result.priceUsd)}
          </span>
          {result.t1Pct != null && (
            <span style={{ fontSize: 9, color: 'var(--ok)', fontFamily: 'var(--font-mono)' }}>
              T1 +{result.t1Pct.toFixed(0)}%
            </span>
          )}
          <span style={{ fontSize: 9, color: 'var(--text-3)', marginLeft: 'auto' }}>{ago}</span>
        </div>
      </div>
    </div>
  );
}

function getAgo(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  return `${Math.floor(diff / 3600)}h`;
}
