'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { QuickBuyModal } from './QuickBuyModal';
import { fmtUsdCompact } from '../lib/format-price';

// ── Public types ────────────────────────────────────────────────────────────

export type CardStatus = 'active' | 'retired' | 'rugged' | 'graduated';
export type CardSource = 'hot_tokens_scan' | 'manual_scan' | 'telegram_scan' | 'snipe';

export interface TokenCardProps {
  href:       string;
  address:    string;
  symbol:     string | null;
  name?:      string | null;
  chain?:     'SOLANA' | 'EVM';
  status:     CardStatus;
  source?:    CardSource;
  capturedAt: string;
  profileKey?: string | null;

  marketCapAtCapture?: number | null;
  pumpedHigh?:         number | null;
  currentMcap?:        number | null;
  peakDelta?:          number | null;
  currentDelta?:       number | null;
  sparkline?:          number[];

  aiScore?:    number | null;
  aiVerdict?:  string | null;
  aiSummary?:  string | null;
  t1Pct?:      number | null;
  riskReward?: number | null;

  // isFresh = true  → NEW badge + pulse anim
  // isFresh = false → Analyzing… spinner (live mode, waiting for verdict)
  // isFresh = undefined → no badges / no entry animation (historical cards)
  isFresh?: boolean;

  reappearedAt?:     string | null;
  reappearedSource?: string | null;

  // Indicator strip: caller can pass any number of short badge nodes.
  // BullBearIndicator is always prepended automatically.
  indicators?: React.ReactNode[];
}

// ── Theme maps ──────────────────────────────────────────────────────────────

const STATUS_TONE: Record<CardStatus, string> = {
  active:    'var(--accent)',
  graduated: 'var(--ok)',
  retired:   'var(--text-3)',
  rugged:    'var(--bad)',
};

const SOURCE_LABEL: Record<CardSource, string> = {
  hot_tokens_scan: '🔥 Hot',
  manual_scan:     '🔍 Manual',
  telegram_scan:   '📱 Tg',
  snipe:           '🎯 Snipe',
};

const SOURCE_TONE: Record<CardSource, string> = {
  hot_tokens_scan: '#f59e0b',
  manual_scan:     '#a855f7',
  telegram_scan:   '#3b82f6',
  snipe:           '#22c55e',
};

export const VERDICT_COLOR: Record<string, string> = {
  STRONG_BUY: '#22c55e',
  BUY:        '#4ade80',
  CAUTIOUS:   '#f59e0b',
  SKIP:       '#8a8fa3',
  HIGH_RISK:  '#ef4444',
};

export const VERDICT_LABEL: Record<string, string> = {
  STRONG_BUY: '🔥 STRONG BUY',
  BUY:        '✅ BUY',
  CAUTIOUS:   '⚠ CAUTIOUS',
  HIGH_RISK:  '🛑 HIGH RISK',
  SKIP:       '— SKIP',
};

// ── Built-in indicator: Bull / Bear ─────────────────────────────────────────

/**
 * BULL (▲, green) or BEAR (▼, red/amber/grey) pill shown on every analyzed token.
 *
 * Verdict → direction + colour:
 *   STRONG_BUY → BULL  var(--ok)    bright green
 *   BUY        → BULL  #4ade80      lighter green
 *   CAUTIOUS   → BEAR  var(--warn)  amber  (caution = not a buy)
 *   SKIP       → BEAR  var(--text-3) grey  (neutral / pass)
 *   HIGH_RISK  → BEAR  var(--bad)   red
 *
 * Score-only fallback (no verdict): ≥ 65 → BULL, < 40 → BEAR, 40–64 → nothing.
 * size="sm" for inline card strips, size="md" for larger verdict headers.
 */
export function BullBearIndicator({
  verdict,
  score,
  size = 'sm',
}: {
  verdict?: string | null;
  score?: number | null;
  size?: 'sm' | 'md';
}) {
  // Verdict-driven direction
  const bull =
    verdict === 'STRONG_BUY' ||
    verdict === 'BUY' ||
    (!verdict && score != null && score >= 65);
  const bear =
    verdict === 'HIGH_RISK' ||
    verdict === 'CAUTIOUS' ||
    verdict === 'SKIP' ||
    (!verdict && score != null && score < 40);

  if (!bull && !bear) return null;

  // Colour varies by verdict severity
  const color =
    verdict === 'STRONG_BUY' ? 'var(--ok)'     :
    verdict === 'BUY'        ? '#4ade80'        :
    verdict === 'HIGH_RISK'  ? 'var(--bad)'     :
    verdict === 'CAUTIOUS'   ? 'var(--warn)'    :
    verdict === 'SKIP'       ? 'var(--text-3)'  :
    bull                     ? 'var(--ok)'      : 'var(--bad)';

  const title =
    verdict === 'STRONG_BUY' ? 'Strong bullish signal'    :
    verdict === 'BUY'        ? 'Bullish signal'            :
    verdict === 'HIGH_RISK'  ? 'High-risk / bearish'       :
    verdict === 'CAUTIOUS'   ? 'Cautious — lean bearish'   :
    verdict === 'SKIP'       ? 'Skip — no directional play':
    bull ? 'Bullish (score)' : 'Bearish (score)';

  const isMd = size === 'md';
  const px   = isMd ? 9 : 7;

  return (
    <span
      title={title}
      style={{
        fontSize:      isMd ? 11 : 9,
        fontWeight:    700,
        letterSpacing: '0.06em',
        padding:       isMd ? '4px 9px' : '2px 6px',
        borderRadius:  5,
        background:    `color-mix(in srgb, ${color} 12%, transparent)`,
        border:        `1px solid color-mix(in srgb, ${color} 30%, var(--border))`,
        color,
        display:       'inline-flex',
        alignItems:    'center',
        gap:           4,
        cursor:        'default',
        userSelect:    'none',
        fontFamily:    'var(--font-mono)',
        flexShrink:    0,
      }}
    >
      {bull ? (
        <svg width={px} height={px} viewBox="0 0 8 8" fill="currentColor" aria-hidden style={{ display: 'block' }}>
          <polygon points="4,0.5 7.5,7.5 0.5,7.5" />
        </svg>
      ) : (
        <svg width={px} height={px} viewBox="0 0 8 8" fill="currentColor" aria-hidden style={{ display: 'block' }}>
          <polygon points="4,7.5 7.5,0.5 0.5,0.5" />
        </svg>
      )}
      {bull ? 'BULL' : 'BEAR'}
    </span>
  );
}

// ── Internal helpers ────────────────────────────────────────────────────────

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 5_000)      return 'just now';
  if (ms < 60_000)     return `${Math.floor(ms / 1_000)}s`;
  if (ms < 3_600_000)  return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

function StatCell({
  label,
  value,
  delta,
}: {
  label: string;
  value: React.ReactNode;
  delta?: number | null;
}) {
  const color =
    delta == null ? 'var(--text-1)' : delta >= 0 ? 'var(--ok)' : 'var(--bad)';
  return (
    <div>
      <div
        style={{
          fontSize: 9,
          color: 'var(--text-3)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          marginBottom: 2,
        }}
      >
        {label}
      </div>
      <div className="font-mono" style={{ fontSize: 12, fontWeight: 700, color }}>
        {value}
      </div>
      {delta != null && (
        <div style={{ fontSize: 10, fontWeight: 600, color, marginTop: 1 }}>
          {delta >= 0 ? '+' : ''}
          {delta.toFixed(0)}%
        </div>
      )}
    </div>
  );
}

function Sparkline({ values, delta }: { values: number[]; delta: number }) {
  if (!values?.length || values.length < 2) {
    return (
      <div
        style={{
          height: 28,
          opacity: 0.2,
          fontSize: 9,
          color: 'var(--text-3)',
          textAlign: 'center',
          lineHeight: '28px',
        }}
      >
        ── awaiting ticks ──
      </div>
    );
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const W = 200;
  const H = 28;
  const pts = values
    .map((v, i) => {
      const x = ((i / Math.max(values.length - 1, 1)) * W).toFixed(1);
      const y = (H - ((v - min) / range) * H).toFixed(1);
      return `${x},${y}`;
    })
    .join(' ');
  const stroke = delta >= 0 ? 'var(--ok)' : 'var(--bad)';
  const gid = `spk-${delta >= 0 ? 'up' : 'dn'}`;
  return (
    <svg
      width="100%"
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      <defs>
        <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polyline
        points={`0,${H} ${pts} ${W},${H}`}
        fill={`url(#${gid})`}
        stroke="none"
      />
      <polyline
        points={pts}
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CopyBtn({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    navigator.clipboard
      .writeText(address)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
  };
  return (
    <button
      onClick={copy}
      title={copied ? 'Copied!' : 'Copy contract address'}
      style={{
        padding: '4px 8px',
        borderRadius: 5,
        cursor: 'pointer',
        background: copied
          ? 'color-mix(in srgb, var(--ok) 12%, transparent)'
          : 'var(--surface-2)',
        border: `1px solid ${
          copied
            ? 'color-mix(in srgb, var(--ok) 30%, var(--border))'
            : 'var(--border)'
        }`,
        color: copied ? 'var(--ok)' : 'var(--text-3)',
        fontSize: 13,
        lineHeight: 1,
        display: 'inline-flex',
        alignItems: 'center',
        transition: 'all 150ms',
      }}
    >
      {copied ? '✓' : '⎘'}
    </button>
  );
}

// ── TokenCard ────────────────────────────────────────────────────────────────

export function TokenCard({
  href,
  address,
  symbol,
  name,
  chain = 'SOLANA',
  status,
  source,
  capturedAt,
  profileKey,
  marketCapAtCapture,
  pumpedHigh,
  currentMcap,
  peakDelta,
  currentDelta,
  sparkline = [],
  aiScore,
  aiVerdict,
  aiSummary,
  t1Pct,
  riskReward,
  isFresh,
  reappearedAt,
  indicators = [],
}: TokenCardProps) {
  const [buyOpen, setBuyOpen] = useState(false);
  const tickRef  = useRef<HTMLSpanElement>(null);
  const lastMcap = useRef(currentMcap);

  // Flash "Now" cell on live price update
  useEffect(() => {
    if (currentMcap == null || lastMcap.current === currentMcap) return;
    lastMcap.current = currentMcap;
    const el = tickRef.current;
    if (!el) return;
    el.style.transition = 'none';
    el.style.color = 'var(--accent)';
    requestAnimationFrame(() => {
      el.style.transition = 'color 800ms ease';
      el.style.color = '';
    });
  }, [currentMcap]);

  const sourceTone   = source ? (SOURCE_TONE[source] ?? 'var(--accent)') : 'var(--accent)';
  const statusTone   = STATUS_TONE[status] ?? 'var(--text-3)';
  const analyzed     = aiVerdict != null;
  const verdictColor = aiVerdict ? (VERDICT_COLOR[aiVerdict] ?? 'var(--text-3)') : undefined;
  const peak         = peakDelta;
  const peakColor    =
    peak == null ? 'var(--text-3)' :
    peak >= 50   ? 'var(--ok)'    :
    peak >= 5    ? 'var(--accent)' :
    'var(--text-3)';
  // liveMode: card is in a streaming context (isFresh is explicitly provided)
  const liveMode = isFresh !== undefined;

  // Bull/Bear is now in the verdict banner (top of card, always visible).
  // Only add it to the bottom strip for score-only tokens that have no verdict banner.
  const showBullBearInStrip = !analyzed && aiScore != null;
  const allIndicators: React.ReactNode[] = [
    showBullBearInStrip
      ? <BullBearIndicator key="__bb" verdict={aiVerdict} score={aiScore} />
      : null,
    ...indicators,
  ].filter(Boolean);

  return (
    <>
      <Link
        href={href}
        style={{
          textDecoration: 'none',
          color: 'inherit',
          position: 'relative',
          border:
            analyzed && verdictColor
              ? `1px solid color-mix(in srgb, ${verdictColor} 45%, var(--border))`
              : '1px solid var(--border)',
          borderRadius: 12,
          padding: '14px 16px',
          background:
            analyzed && verdictColor
              ? `radial-gradient(circle at 0% 0%, color-mix(in srgb, ${verdictColor} 10%, transparent) 0%, transparent 55%), var(--surface-1)`
              : `radial-gradient(circle at 0% 0%, color-mix(in srgb, ${sourceTone} 14%, transparent) 0%, transparent 55%), var(--surface-1)`,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          animation: liveMode
            ? isFresh
              ? 'token-card-in 360ms cubic-bezier(0.2,0.8,0.2,1), token-card-pulse 1.6s ease-in-out 0s 3'
              : 'token-card-in 280ms cubic-bezier(0.2,0.8,0.2,1)'
            : undefined,
          transition: 'transform 0.18s ease, border-color 0.18s ease',
          boxShadow:
            analyzed && verdictColor
              ? `0 0 18px -6px color-mix(in srgb, ${verdictColor} 30%, transparent)`
              : undefined,
        }}
      >
        {/* ── NEW badge (live mode, just arrived) ── */}
        {liveMode && isFresh && !analyzed && (
          <span
            style={{
              position: 'absolute',
              top: 8,
              right: 8,
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: '0.08em',
              padding: '2px 6px',
              borderRadius: 4,
              background: 'var(--accent)',
              color: 'white',
              textTransform: 'uppercase',
            }}
          >
            NEW
          </span>
        )}

        {/* ── Analyzing… spinner (live mode, waiting for verdict) ── */}
        {liveMode && !isFresh && !analyzed && (
          <span
            style={{
              position: 'absolute',
              top: 8,
              right: 8,
              fontSize: 9,
              fontWeight: 600,
              letterSpacing: '0.06em',
              padding: '2px 7px',
              borderRadius: 4,
              background: 'color-mix(in srgb, var(--accent) 10%, var(--surface-2))',
              border: '1px solid color-mix(in srgb, var(--accent) 25%, var(--border))',
              color: 'var(--text-3)',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <span
              style={{
                display: 'inline-block',
                animation: 'token-card-spin 1.2s linear infinite',
              }}
            >
              ⏳
            </span>
            Analyzing…
          </span>
        )}

        {/* ── Verdict banner (bull/bear lives here — always visible) ── */}
        {analyzed && verdictColor && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              background: `color-mix(in srgb, ${verdictColor} 12%, var(--surface-2))`,
              border: `1px solid color-mix(in srgb, ${verdictColor} 35%, var(--border))`,
              borderRadius: 8,
              padding: '6px 10px',
              gap: 8,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
              {/* Bull/Bear pill — first thing you see on an analyzed card */}
              <BullBearIndicator verdict={aiVerdict} score={aiScore} />
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: '0.07em',
                  color: verdictColor,
                  textTransform: 'uppercase',
                  whiteSpace: 'nowrap',
                }}
              >
                {VERDICT_LABEL[aiVerdict!] ?? aiVerdict}
              </span>
              {aiScore != null && (
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 13,
                    fontWeight: 700,
                    color: verdictColor,
                  }}
                >
                  {aiScore}
                  <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--text-3)' }}>
                    /100
                  </span>
                </span>
              )}
            </div>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-end',
                gap: 2,
              }}
            >
              {t1Pct != null && (
                <span
                  style={{
                    fontSize: 10,
                    color: 'var(--ok)',
                    fontFamily: 'var(--font-mono)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  T1 +{t1Pct.toFixed(0)}%
                </span>
              )}
              {riskReward != null && (
                <span
                  style={{
                    fontSize: 10,
                    color: 'var(--text-3)',
                    fontFamily: 'var(--font-mono)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  R:R {riskReward.toFixed(1)}x
                </span>
              )}
            </div>
          </div>
        )}

        {/* ── AI summary ── */}
        {analyzed && aiSummary && (
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-2)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              opacity: 0.85,
            }}
          >
            {aiSummary}
          </div>
        )}

        {/* ── Header: symbol + status chip ── */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            gap: 8,
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                fontSize: 16,
                fontWeight: 700,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {status === 'graduated' && '🚀 '}
              {symbol ?? address.slice(0, 6)}
            </div>
            {name && name !== symbol && (
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--text-3)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {name}
              </div>
            )}
          </div>
          <span
            className="chip"
            style={{
              background: `color-mix(in srgb, ${statusTone} 16%, transparent)`,
              borderColor: `color-mix(in srgb, ${statusTone} 40%, var(--border))`,
              color: statusTone,
              fontSize: 9,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}
          >
            {status}
          </span>
        </div>

        {/* ── Metadata: source · time · profile ── */}
        <div
          style={{
            display: 'flex',
            gap: 6,
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          {source && (
            <span
              style={{
                fontSize: 10,
                color: sourceTone,
                fontWeight: 600,
                background: `color-mix(in srgb, ${sourceTone} 12%, transparent)`,
                padding: '2px 6px',
                borderRadius: 4,
                border: `1px solid color-mix(in srgb, ${sourceTone} 30%, var(--border))`,
              }}
            >
              {SOURCE_LABEL[source] ?? source}
            </span>
          )}
          <span style={{ fontSize: 10, color: 'var(--text-3)' }}>
            · {relTime(capturedAt)}
          </span>
          {profileKey && (
            <span style={{ fontSize: 10, color: 'var(--text-3)' }}>
              · {profileKey}
            </span>
          )}
          {reappearedAt && (
            <span style={{ fontSize: 10, color: 'var(--accent)' }}>
              ↺ re-appeared
            </span>
          )}
        </div>

        {/* ── Stat row ── */}
        <div
          style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}
        >
          <StatCell label="Entry" value={fmtUsdCompact(marketCapAtCapture)} />
          <StatCell label="Peak"  value={fmtUsdCompact(pumpedHigh)} delta={peak} />
          <StatCell
            label="Now"
            value={<span ref={tickRef}>{fmtUsdCompact(currentMcap)}</span>}
            delta={currentDelta}
          />
        </div>

        {/* ── Sparkline ── */}
        <Sparkline values={sparkline} delta={peak ?? 0} />

        {/* ── Peak delta big number ── */}
        {peak != null && peak > 0 && (
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-3)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
            }}
          >
            <span>peak delta</span>
            <span style={{ fontSize: 18, fontWeight: 700, color: peakColor }}>
              +{peak.toFixed(0)}%
            </span>
          </div>
        )}

        {/* ── Indicator strip ── */}
        {allIndicators.length > 0 && (
          <div
            style={{
              display: 'flex',
              gap: 5,
              flexWrap: 'wrap',
              alignItems: 'center',
            }}
          >
            {allIndicators}
          </div>
        )}

        {/* ── Action row: icon-only buttons ── */}
        <div
          style={{ display: 'flex', gap: 5, marginTop: 2 }}
          onClick={(e) => e.preventDefault()}
        >
          <button
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setBuyOpen(true);
            }}
            title="Quick snipe buy"
            style={{
              padding: '4px 8px',
              borderRadius: 5,
              cursor: 'pointer',
              background: 'color-mix(in srgb, var(--ok) 12%, transparent)',
              border: '1px solid color-mix(in srgb, var(--ok) 30%, var(--border))',
              color: 'var(--ok)',
              fontSize: 14,
              lineHeight: 1,
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            ⚡
          </button>
          <CopyBtn address={address} />
        </div>
      </Link>

      {buyOpen && (
        <QuickBuyModal
          address={address}
          symbol={symbol}
          chain={chain}
          mode="buy"
          onClose={() => setBuyOpen(false)}
        />
      )}
    </>
  );
}
