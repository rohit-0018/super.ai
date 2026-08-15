'use client';
import { useState, useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { type HotToken } from '../lib/useHotTokens';
import { useNetworkFeed, chainName, type UnifiedToken } from '../lib/useNetworkFeed';
import { useNetwork } from '../lib/NetworkContext';
import { ChainBadge } from './ui/ChainBadge';
import { fmtPriceUsd } from '../lib/format-price';
import { QuickBuyModal } from './QuickBuyModal';

/* ─── CopyCA — inline copy button for contract address ──────────────────────── */
function CopyCA({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const short = `${address.slice(0, 4)}…${address.slice(-4)}`;
  return (
    <span
      title={address}
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(address).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      style={{
        fontFamily: 'var(--font-mono)', fontSize: 9, color: copied ? 'var(--ok)' : 'var(--text-3)',
        background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 3,
        padding: '1px 4px', cursor: 'pointer', letterSpacing: '0.02em', transition: 'color 120ms',
        userSelect: 'none', flexShrink: 0,
      }}
    >
      {copied ? '✓' : short}
    </span>
  );
}

/* ─── helpers ──────────────────────────────────────────────────────────────── */
function verdictColor(v?: HotToken['verdict']): string {
  switch (v) {
    case 'STRONG_BUY': return 'var(--ok)';
    case 'BUY':        return '#4ade80';
    case 'CAUTIOUS':   return 'var(--warn)';
    case 'SKIP':       return 'var(--text-3)';
    case 'HIGH_RISK':  return 'var(--bad)';
    default:           return 'var(--text-3)';
  }
}

function verdictLabel(v?: HotToken['verdict']): string {
  switch (v) {
    case 'STRONG_BUY': return 'STRONG';
    case 'BUY':        return 'BUY';
    case 'CAUTIOUS':   return 'CAUTION';
    case 'SKIP':       return 'SKIP';
    case 'HIGH_RISK':  return 'RISK';
    default:           return '';
  }
}

function ageLabel(hours?: number): string {
  if (hours == null) return '';
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

/* ─── Individual chip — button so click always fires, even inside marquee ───── */
function TokenChip({ token, onClick, showChain }: { token: UnifiedToken; onClick: (t: UnifiedToken) => void; showChain: boolean }) {
  const [buyOpen, setBuyOpen] = useState(false);
  const col = verdictColor(token.verdict);
  const isBullish = token.verdict === 'STRONG_BUY' || token.verdict === 'BUY';
  const changeUp = (token.priceChange1h ?? 0) >= 0;

  return (
    <>
      <div
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0,
          background: isBullish ? `${col}10` : 'var(--surface-2)',
          border: `1px solid ${isBullish ? `${col}30` : 'var(--border)'}`,
          borderRadius: 8, padding: '4px 6px 4px 9px',
          boxShadow: `inset 0 1px 0 var(--highlight)${isBullish ? `, 0 0 8px ${col}14` : ''}`,
          whiteSpace: 'nowrap',
        }}
      >
        <button
          onClick={() => onClick(token)}
          title={`Open ${token.symbol} analysis`}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            background: 'none', border: 'none', cursor: 'pointer', outline: 'none', padding: 0,
          }}
        >
          {showChain
            ? <ChainBadge chain={token.chain} size="xs" showLabel={false} />
            : <span style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: col, boxShadow: isBullish ? `0 0 5px ${col}` : undefined }} />}
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: 'var(--text)', letterSpacing: '0.03em' }}>
            {token.symbol}
          </span>
          <CopyCA address={token.address} />
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-2)' }}>
            {fmtPrice(token.priceUsd)}
          </span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: changeUp ? 'var(--ok)' : 'var(--bad)', minWidth: 42, textAlign: 'right' }}>
            {token.priceChange1h == null ? '—' : fmtChange(token.priceChange1h)}
          </span>
          <span style={{ fontSize: 10, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
            {ageLabel(token.pairAgeHours)}
          </span>
          {token.verdict && (
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', color: col, fontFamily: 'var(--font-mono)', background: `${col}18`, borderRadius: 4, padding: '1px 4px' }}>
              {verdictLabel(token.verdict)}
            </span>
          )}
          {token.score != null && (
            <span style={{ fontSize: 10, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
              {token.score}
            </span>
          )}
        </button>
        {/* Quick buy button inline in the chip */}
        <button
          onClick={(e) => { e.stopPropagation(); setBuyOpen(true); }}
          title={`Quick buy ${token.symbol}`}
          style={{
            display: 'inline-flex', alignItems: 'center',
            padding: '2px 6px', marginLeft: 3, borderRadius: 5, cursor: 'pointer',
            background: 'color-mix(in srgb, var(--ok) 15%, transparent)',
            border: '1px solid color-mix(in srgb, var(--ok) 35%, var(--border))',
            color: 'var(--ok)', fontSize: 10, fontWeight: 700,
            transition: 'background 100ms',
          }}
        >
          ⚡
        </button>
      </div>

      {buyOpen && (
        <QuickBuyModal
          address={token.address}
          symbol={token.symbol}
          chain={token.chain === 'solana' ? 'SOLANA' : 'EVM'}
          mode="buy"
          onClose={() => setBuyOpen(false)}
        />
      )}
    </>
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

/**
 * Below this many tokens the strip is rendered static rather than scrolled —
 * a duplicated two-item loop looks broken, not busy.
 */
const MARQUEE_MIN_TOKENS = 6;

/* ─── Marquee ticker wrapper ─────────────────────────────────────────────────── */
function TokenTicker({ tokens, onClick, showChain }: { tokens: UnifiedToken[]; onClick: (t: UnifiedToken) => void; showChain: boolean }) {
  const [paused, setPaused] = useState(false);

  /**
   * The marquee duplicates the list for a seamless loop. That reads as a bug
   * when a chain only has a handful of tokens — scoping to BNB Chain showed
   * "八八火发, 安迪, 八八火发, 安迪" scrolling past, which looks like a rendering
   * fault rather than a short list. Below the threshold we render a static row
   * instead: nothing is repeated, nothing moves, and the content is all visible.
   */
  const shouldScroll = tokens.length >= MARQUEE_MIN_TOKENS;
  const items = shouldScroll ? [...tokens, ...tokens] : tokens;
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
        // Longhand only: mixing the `animation` shorthand with `animationPlayState`
        // makes React warn, because it cannot reconcile the two on rerender.
        ...(shouldScroll ? {
          animationName: 'hot-scroll',
          animationDuration: `${durationSec}s`,
          animationTimingFunction: 'linear',
          animationIterationCount: 'infinite',
          animationPlayState: paused ? 'paused' : 'running',
        } : {}),
        paddingLeft: 10,
      }}>
        {items.map((t, i) => (
          <TokenChip key={`${t.chain}-${t.address}-${i}`} token={t} onClick={onClick} showChain={showChain} />
        ))}
      </div>
    </div>
  );
}

/* ─── Bar ────────────────────────────────────────────────────────────────────── */
export function HotTokensBar() {
  const { network, isAll } = useNetwork();
  const { tokens: feedTokens, loading } = useNetworkFeed(60);
  const router = useRouter();

  // Highest-volume first. The Solana-only scanner used scan recency, but that
  // ordering is meaningless once rows arrive from chains with no scan clock —
  // volume is the one signal every chain reports.
  const tokens = useMemo(
    () => [...feedTokens].sort((a, b) => b.volume24hUsd - a.volume24hUsd),
    [feedTokens],
  );
  const hasTokens = tokens.length > 0;

  // Label the scope so it is obvious what the bar is showing.
  const scopeLabel = isAll ? 'ALL' : chainName(network).toUpperCase();

  function openAnalysis(token: UnifiedToken) {
    router.push(`/intel?address=${encodeURIComponent(token.address)}&chain=${token.chain}`);
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
        {!isAll && <ChainBadge chain={network} size="xs" showLabel={false} />}
        <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.1em', color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
          {scopeLabel}
        </span>
      </div>

      {/* ── CENTER: auto-scrolling ticker ──────────────────────────────────── */}
      {hasTokens
        ? <TokenTicker tokens={tokens} onClick={openAnalysis} showChain={isAll} />
        : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', padding: '0 14px' }}>
            <span style={{ color: 'var(--text-3)', fontSize: 11, fontFamily: 'var(--font-mono)' }}>
              {loading
                ? 'Scanning…'
                : `No tokens on ${isAll ? 'any network' : chainName(network)} yet`}
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

      </div>
    </div>
  );
}
