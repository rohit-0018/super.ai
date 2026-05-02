'use client';
import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useHotTokens, type HotToken } from '../lib/useHotTokens';
import { fmtPriceUsd } from '../lib/format-price';

/* ─── helpers ──────────────────────────────────────────────────────────────── */
function verdictColor(v: HotToken['verdict']): string {
  switch (v) {
    case 'STRONG_BUY': return 'var(--ok)';
    case 'BUY':        return '#4ade80';
    case 'CAUTIOUS':   return 'var(--warn)';
    case 'SKIP':       return 'var(--text-3)';
    case 'HIGH_RISK':  return 'var(--bad)';
  }
}

function verdictLabel(v: HotToken['verdict']): string {
  switch (v) {
    case 'STRONG_BUY': return 'STRONG';
    case 'BUY':        return 'BUY';
    case 'CAUTIOUS':   return 'CAUTION';
    case 'SKIP':       return 'SKIP';
    case 'HIGH_RISK':  return 'RISK';
  }
}

function ageLabel(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${Math.floor(hours / 24)}d`;
}

function fmtPrice(p: number): string {
  if (p === 0) return '—';
  return fmtPriceUsd(p);
}

function fmtChange(pct: number): string {
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

/* ─── Countdown ─────────────────────────────────────────────────────────────── */
function Countdown({ nextScanAt }: { nextScanAt: string | null }) {
  const [secs, setSecs] = useState<number | null>(null);
  useEffect(() => {
    if (!nextScanAt) return;
    const update = () =>
      setSecs(Math.max(0, Math.round((new Date(nextScanAt).getTime() - Date.now()) / 1000)));
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, [nextScanAt]);

  if (secs === null) return null;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return (
    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
      {secs === 0 ? 'scanning…' : `${m}:${String(s).padStart(2, '0')}`}
    </span>
  );
}

/* ─── Individual chip — button so click always fires, even inside marquee ───── */
function TokenChip({ token, onClick }: { token: HotToken; onClick: (t: HotToken) => void }) {
  const col = verdictColor(token.verdict);
  const isBullish = token.verdict === 'STRONG_BUY' || token.verdict === 'BUY';
  const changeUp = token.priceChange1h >= 0;

  return (
    <button
      onClick={() => onClick(token)}
      title={`Open ${token.symbol} analysis`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0,
        background: isBullish ? `${col}10` : 'var(--surface-2)',
        border: `1px solid ${isBullish ? `${col}30` : 'var(--border)'}`,
        borderRadius: 8, padding: '4px 9px', cursor: 'pointer',
        boxShadow: `inset 0 1px 0 var(--highlight)${isBullish ? `, 0 0 8px ${col}14` : ''}`,
        transition: 'border-color 120ms, background 120ms',
        outline: 'none', whiteSpace: 'nowrap',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.borderColor = col;
        e.currentTarget.style.background = `${col}20`;
      }}
      onMouseLeave={e => {
        e.currentTarget.style.borderColor = isBullish ? `${col}30` : 'var(--border)';
        e.currentTarget.style.background = isBullish ? `${col}10` : 'var(--surface-2)';
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: col, boxShadow: isBullish ? `0 0 5px ${col}` : undefined }} />
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: 'var(--text)', letterSpacing: '0.03em' }}>
        {token.symbol}
      </span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-2)' }}>
        {fmtPrice(token.priceUsd)}
      </span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: changeUp ? 'var(--ok)' : 'var(--bad)', minWidth: 42, textAlign: 'right' }}>
        {fmtChange(token.priceChange1h)}
      </span>
      <span style={{ fontSize: 10, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
        {ageLabel(token.pairAgeHours)}
      </span>
      <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', color: col, fontFamily: 'var(--font-mono)', background: `${col}18`, borderRadius: 4, padding: '1px 4px' }}>
        {verdictLabel(token.verdict)}
      </span>
      <span style={{ fontSize: 10, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
        {token.score}
      </span>
    </button>
  );
}

function IconFlame() {
  return (
    <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.657 5.343C15.5 3.5 12 2 12 2s1 4-2 6c-2 1.5-4.5 1-5.657 2.343C2.5 12.5 2 14.5 2 16a10 10 0 0 0 20 0c0-4.667-1.657-8.657-4.343-10.657z"/>
      <path d="M12 22c0 0 3-2.5 3-6s-3-4-3-4-3 1-3 4 3 6 3 6z"/>
    </svg>
  );
}

/* ─── Marquee ticker wrapper ─────────────────────────────────────────────────── */
function TokenTicker({ tokens, onClick }: { tokens: HotToken[]; onClick: (t: HotToken) => void }) {
  const [paused, setPaused] = useState(false);
  // duplicate for seamless loop — need at least some tokens
  const items = tokens.length > 0 ? [...tokens, ...tokens] : [];
  // speed: roughly 60px per second; each chip ≈ 180px; total width = tokens*180
  const durationSec = Math.max(20, tokens.length * 6);

  return (
    <div
      style={{ flex: 1, overflow: 'hidden', height: '100%', display: 'flex', alignItems: 'center', position: 'relative' }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {/* left fade-out mask */}
      <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 24, zIndex: 2, background: 'linear-gradient(to right, var(--surface), transparent)', pointerEvents: 'none' }} />
      {/* right fade-out mask */}
      <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 24, zIndex: 2, background: 'linear-gradient(to left, var(--surface), transparent)', pointerEvents: 'none' }} />

      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        width: 'max-content',
        animation: `hot-scroll ${durationSec}s linear infinite`,
        animationPlayState: paused ? 'paused' : 'running',
        paddingLeft: 10,
      }}>
        {items.map((t, i) => (
          <TokenChip key={`${t.address}-${i}`} token={t} onClick={onClick} />
        ))}
      </div>
    </div>
  );
}

/* ─── Bar ────────────────────────────────────────────────────────────────────── */
const PROFILE_LABELS: Record<string, string> = {
  meme_hunter: 'MEME',
  degen_sniper: 'DEGEN',
  swing_trader: 'SWING',
  gem_hunt: 'GEM',
  alpha_hunt: 'ALPHA',
};

export function HotTokensBar() {
  const { scan, loading } = useHotTokens();
  const router = useRouter();

  const profile      = scan?.profileKey ?? 'meme_hunter';
  const profileLabel = PROFILE_LABELS[profile] ?? profile.toUpperCase();
  const tokens       = scan?.tokens ?? [];
  const hasTokens    = tokens.length > 0;

  function openAnalysis(token: HotToken) {
    router.push(`/intel?address=${encodeURIComponent(token.address)}&profile=${token.profileKey}`);
  }

  return (
    <div style={{
      height: 44,
      background: 'var(--surface)',
      borderTop: '1.5px solid rgba(245,158,11,0.38)',
      borderBottom: '1px solid var(--border)',
      boxShadow: 'inset 0 1px 0 var(--highlight), 0 2px 10px rgba(245,158,11,0.05)',
      display: 'flex',
      alignItems: 'center',
      overflow: 'hidden',
      flexShrink: 0,
    }}>

      {/* ── LEFT badge ────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', flexShrink: 0, alignItems: 'center', gap: 6,
        padding: '0 12px',
        borderRight: '1px solid var(--border)',
        height: '100%',
        background: 'rgba(245,158,11,0.06)',
        minWidth: 'max-content',
      }}>
        <span style={{
          width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
          background: loading ? 'var(--text-3)' : 'var(--warn)',
          boxShadow: loading ? undefined : '0 0 0 2px rgba(245,158,11,0.2)',
          animation: loading ? undefined : 'qwai-live-pulse 2s ease-in-out infinite',
        }} />
        <span style={{ color: 'var(--warn)', display: 'flex', alignItems: 'center' }}>
          <IconFlame />
        </span>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', color: 'var(--warn)', fontFamily: 'var(--font-mono)' }}>
          HOT
        </span>
        <span style={{ width: 1, height: 12, background: 'var(--border)', flexShrink: 0 }} />
        <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.1em', color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
          {profileLabel}
        </span>
      </div>

      {/* ── CENTER: auto-scrolling ticker ──────────────────────────────────── */}
      {hasTokens
        ? <TokenTicker tokens={tokens} onClick={openAnalysis} />
        : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', padding: '0 14px' }}>
            <span style={{ color: 'var(--text-3)', fontSize: 11, fontFamily: 'var(--font-mono)' }}>
              {loading ? 'Scanning…' : 'No hot tokens yet · scan every 10 min'}
            </span>
          </div>
        )
      }

      {/* ── RIGHT: countdown ───────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', flexShrink: 0, alignItems: 'center', gap: 6,
        padding: '0 12px',
        borderLeft: '1px solid var(--border)',
        height: '100%',
        minWidth: 'max-content',
      }}>
        {hasTokens && (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-3)' }}>
            {tokens.length}t
          </span>
        )}
        {scan?.nextScanAt && <Countdown nextScanAt={scan.nextScanAt} />}
      </div>
    </div>
  );
}
