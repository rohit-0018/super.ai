'use client';
import { useState } from 'react';
import { useApi } from '../lib/useApi';
import { useInView, useTokenDetail } from '../lib/useTokenDetail';
import { Spinner } from './ui/Skeleton';
import { fmtPriceUsd } from '../lib/format-price';

export interface ActivityItem {
  kind?: 'buy' | 'sell';
  source?: 'snipe' | 'snipe_auto_sell' | 'manual_sell';
  id: string;
  mint: string;
  amountRaw: string | null;
  outAmount: string | null;
  txHash: string | null;
  status: string;
  errorMsg: string | null;
  sourceMsg: string | null;
  groupId: string | null;
  chain: string;
  attempts: number;
  createdAt: string;
  sellStatus?: string | null;
  sellTxHash?: string | null;
  sellReason?: string | null;
  relatedBuyId?: string | null;
  // Frozen-at-fill snapshot (when available — populated for new snipes)
  priceAtBuyUsd?: number | null;
  mcapAtBuyUsd?: number | null;
  liquidityAtBuyUsd?: number | null;
  solPriceAtBuyUsd?: number | null;
  // Realized exit snapshot (set when sell confirms)
  proceedsSolAtSell?: number | null;
  proceedsUsdAtSell?: number | null;
  pnlUsdRealized?: number | null;
  pnlPctRealized?: number | null;
}

interface Props {
  trade: ActivityItem;
  isActive: boolean;
  onSelect: (t: ActivityItem | null) => void;
  onManualSell?: (id: string) => void;
  selling?: boolean;
}

const LAMPORTS_PER_SOL = 1e9;

/* ── Formatters ─────────────────────────────────────────────────── */
function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(2)}k`;
  if (Math.abs(n) > 0 && Math.abs(n) < 0.01) return fmtPriceUsd(n);
  return `$${n.toFixed(2)}`;
}
function fmtCompactUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}
function fmtPct(n: number | null | undefined): string | null {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}
function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  if (n < 1) return n.toFixed(4);
  return n.toFixed(2);
}

/* ── Token logo ─────────────────────────────────────────────────── */
function TokenLogo({ logoURI, symbol, size = 22 }: { logoURI: string | null; symbol: string; size?: number }) {
  const [errored, setErrored] = useState(false);
  const showImg = logoURI && !errored;
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        flexShrink: 0,
        background: showImg ? 'var(--surface-2)' : 'color-mix(in srgb, var(--accent) 15%, var(--surface-2))',
        border: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 8,
        fontWeight: 700,
        color: 'var(--accent)',
        overflow: 'hidden',
      }}
    >
      {showImg ? (
        <img
          src={logoURI as string}
          alt={symbol}
          width={size}
          height={size}
          onError={() => setErrored(true)}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      ) : (
        symbol.slice(0, 3).toUpperCase()
      )}
    </div>
  );
}

/* ── Row ────────────────────────────────────────────────────────── */
export default function SnipeActivityRow({ trade, isActive, onSelect, onManualSell, selling }: Props) {
  const t = trade;
  const kind: 'buy' | 'sell' = t.kind ?? 'buy';
  const isSelectable = kind === 'buy';
  const { ref, inView } = useInView<HTMLDivElement>();
  const { data: detail } = useTokenDetail(t.mint, inView);

  // SOL/USD — used to convert SOL-denominated cost basis to USD.
  // Cached at the module level via useApi; one fetch shared across all rows.
  const { data: solPriceData } = useApi<{ id: string; priceUsd: number }>(
    `/market/price/solana`,
    { enabled: inView, ttlMs: 60_000 },
  );
  const solPriceUsd = solPriceData?.priceUsd ?? null;

  // ── Derive trade economics from existing fields ────────────────
  // Buys: amountRaw = lamports spent, outAmount = base-unit tokens received.
  // Sells: amountRaw = base-unit tokens sold, outAmount = lamports received (when set).
  const decimals = detail?.decimals ?? null;

  const buySolSpent = kind === 'buy' && t.amountRaw ? Number(t.amountRaw) / LAMPORTS_PER_SOL : null;
  const tokensReceivedUi = kind === 'buy' && t.outAmount && decimals !== null
    ? Number(t.outAmount) / 10 ** decimals
    : null;

  const sellTokensUi = kind === 'sell' && t.amountRaw && decimals !== null
    ? Number(t.amountRaw) / 10 ** decimals
    : null;
  const sellSolReceived = kind === 'sell' && t.outAmount ? Number(t.outAmount) / LAMPORTS_PER_SOL : null;

  // Prefer the SOL/USD frozen at fill time (exact historical) over the live one
  // (approximate). The snapshot is null for trades made before the migration.
  const solPriceForCost = t.solPriceAtBuyUsd ?? solPriceUsd;
  const costBasisUsd = buySolSpent !== null && solPriceForCost !== null
    ? buySolSpent * solPriceForCost
    : null;

  // Per-token buy price — prefer snapshotted priceAtBuyUsd (exact at fill).
  // Fallback to amountIn/amountOut ratio × current SOL price.
  const derivedBuyPriceSol = buySolSpent !== null && tokensReceivedUi && tokensReceivedUi > 0
    ? buySolSpent / tokensReceivedUi
    : null;
  const buyPriceUsd = t.priceAtBuyUsd
    ?? (derivedBuyPriceSol !== null && solPriceForCost !== null ? derivedBuyPriceSol * solPriceForCost : null);

  // Mcap-at-buy — only available from the snapshot. We don't try to back-derive.
  const mcapAtBuy = t.mcapAtBuyUsd ?? null;

  // Current value of the position (unrealized for buys without recorded sell yet).
  const currentPriceUsd = detail?.priceUsd ?? null;
  const currentValueUsd = kind === 'buy' && tokensReceivedUi !== null && currentPriceUsd !== null
    ? tokensReceivedUi * currentPriceUsd
    : null;

  // P&L — prefer realized snapshot if the trade is closed.
  const isClosed = kind === 'buy' && !!t.sellStatus && t.sellStatus !== 'pending';
  const pnlUsd = isClosed && t.pnlUsdRealized != null
    ? t.pnlUsdRealized
    : kind === 'buy' && currentValueUsd !== null && costBasisUsd !== null
      ? currentValueUsd - costBasisUsd
      : null;
  const pnlPct = isClosed && t.pnlPctRealized != null
    ? t.pnlPctRealized
    : pnlUsd !== null && costBasisUsd && costBasisUsd > 0
      ? (pnlUsd / costBasisUsd) * 100
      : null;

  // Sell-side: realized USD in. Prefer the snapshot stored at sell time.
  const sellProceedsUsd = t.proceedsUsdAtSell
    ?? (kind === 'sell' && sellSolReceived !== null && solPriceUsd !== null ? sellSolReceived * solPriceUsd : null);
  const sellPnlPct = t.pnlPctRealized ?? null;
  const sellPnlUsd = t.pnlUsdRealized ?? null;

  // ── Display state ──────────────────────────────────────────────
  const ok = t.status === 'confirmed';
  const broadcasting = t.status === 'broadcast';
  const sideColor = kind === 'buy' ? 'var(--ok)' : 'var(--bad)';
  const statusColor = ok ? 'var(--ok)'
    : t.status === 'failed' ? 'var(--bad)'
    : broadcasting ? 'var(--warn)'
    : 'var(--text-3)';
  const rowTint = kind === 'buy'
    ? 'color-mix(in srgb, var(--ok) 4%, transparent)'
    : 'color-mix(in srgb, var(--bad) 5%, transparent)';
  const pnlColor = pnlPct === null ? 'var(--text-3)' : pnlPct >= 0 ? 'var(--ok)' : 'var(--bad)';

  const symbol = detail?.symbol ?? t.mint.slice(0, 4);
  const change24h = detail?.priceChange24hPct ?? null;
  const change24hColor = change24h === null ? 'var(--text-3)' : change24h >= 0 ? 'var(--ok)' : 'var(--bad)';

  const canSell = kind === 'buy' && !t.sellStatus && (t.status === 'broadcast' || t.status === 'confirmed') && t.source === 'snipe';

  return (
    <div
      ref={ref}
      onClick={() => isSelectable && onSelect(isActive ? null : t)}
      style={{
        cursor: isSelectable ? 'pointer' : 'default',
        background: isActive ? 'color-mix(in srgb, var(--accent) 8%, transparent)' : rowTint,
        borderLeft: `2px solid ${isActive ? 'var(--accent)' : sideColor}`,
        borderBottom: '1px solid var(--border)',
        transition: 'background 80ms',
      }}
    >
      {/* Top line — primary identity + price + side chip */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px 2px' }}>
        <span
          style={{
            fontSize: 9, fontWeight: 800, letterSpacing: '0.05em',
            padding: '2px 6px', borderRadius: 4,
            background: `color-mix(in srgb, ${sideColor} 18%, transparent)`,
            color: sideColor, flexShrink: 0, minWidth: 32, textAlign: 'center',
          }}
        >
          {kind === 'buy' ? 'BUY' : 'SELL'}
        </span>
        <span style={{
          width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
          background: statusColor,
          boxShadow: ok ? `0 0 4px ${statusColor}` : undefined,
        }} />

        <TokenLogo logoURI={detail?.logoURI ?? null} symbol={symbol} />

        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 5 }}>
          <span className="text-[12px] font-semibold" style={{ color: 'var(--text)' }}>{symbol}</span>
          {detail?.name && detail.name !== symbol && (
            <span
              className="text-[10px]"
              style={{ color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 100 }}
            >
              {detail.name}
            </span>
          )}
          <span className="font-mono text-[9px]" style={{ color: 'var(--text-3)' }}>
            {t.mint.slice(0, 4)}…{t.mint.slice(-4)}
          </span>
        </div>

        <div style={{ textAlign: 'right', flexShrink: 0, minWidth: 60 }}>
          <div className="font-mono text-[11px]" style={{ color: 'var(--text)' }}>
            {currentPriceUsd !== null ? fmtUsd(currentPriceUsd) : '—'}
          </div>
          {change24h !== null && (
            <div className="font-mono text-[9px]" style={{ color: change24hColor }}>
              {fmtPct(change24h)}
            </div>
          )}
        </div>
      </div>

      {/* Middle line — trade-level economics (DexScreener-style mini stats) */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
        gap: 6,
        padding: '0 12px 4px',
      }}>
        {kind === 'buy' ? (
          <>
            <Stat
              label="Spent"
              value={buySolSpent !== null ? `${buySolSpent.toFixed(3)} SOL` : '—'}
              sub={costBasisUsd !== null ? fmtUsd(costBasisUsd) : null}
            />
            <Stat
              label="Got"
              value={tokensReceivedUi !== null ? fmtTokens(tokensReceivedUi) : '—'}
              sub={buyPriceUsd !== null ? `@ ${fmtUsd(buyPriceUsd)}` : null}
            />
            <Stat
              label={mcapAtBuy !== null ? 'Mcap @ buy → now' : 'Mcap'}
              value={fmtCompactUsd(mcapAtBuy ?? detail?.marketCap)}
              sub={
                mcapAtBuy !== null && detail?.marketCap !== null && detail?.marketCap !== undefined
                  ? `→ ${fmtCompactUsd(detail.marketCap)}`
                  : detail?.liquidity != null
                    ? `liq ${fmtCompactUsd(detail.liquidity)}`
                    : null
              }
            />
            <Stat
              label={isClosed ? 'Realized P&L' : 'P&L'}
              value={pnlPct !== null ? fmtPct(pnlPct) ?? '—' : '—'}
              sub={pnlUsd !== null ? `${pnlUsd >= 0 ? '+' : ''}${fmtUsd(pnlUsd)}` : null}
              valueColor={pnlColor}
            />
          </>
        ) : (
          <>
            <Stat
              label="Sold"
              value={sellTokensUi !== null ? fmtTokens(sellTokensUi) : '—'}
              sub={null}
            />
            <Stat
              label="Got"
              value={sellSolReceived !== null ? `${sellSolReceived.toFixed(3)} SOL` : '—'}
              sub={sellProceedsUsd !== null ? fmtUsd(sellProceedsUsd) : null}
            />
            <Stat
              label="Mcap @ sell"
              value={fmtCompactUsd(detail?.marketCap)}
              sub={t.mcapAtBuyUsd != null ? `buy ${fmtCompactUsd(t.mcapAtBuyUsd)}` : null}
            />
            <Stat
              label={sellPnlPct !== null ? 'Realized P&L' : 'Reason'}
              value={
                sellPnlPct !== null
                  ? fmtPct(sellPnlPct) ?? (t.sellReason ?? '—')
                  : t.sellReason ?? '—'
              }
              sub={sellPnlUsd !== null ? `${sellPnlUsd >= 0 ? '+' : ''}${fmtUsd(sellPnlUsd)}` : null}
              valueColor={
                sellPnlPct === null ? undefined : sellPnlPct >= 0 ? 'var(--ok)' : 'var(--bad)'
              }
            />
          </>
        )}
      </div>

      {/* Bottom line — status, tx, time, sell button */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '0 12px 6px',
      }}>
        <span style={{ fontSize: 9, fontWeight: 700, color: statusColor, letterSpacing: '0.04em' }}>
          {t.status === 'confirmed' ? 'FILLED' : t.status === 'broadcast' ? 'PENDING' : t.status === 'failed' ? 'FAILED' : t.status.toUpperCase()}
        </span>

        {t.attempts > 1 && (
          <span className="font-mono text-[9px]" style={{ color: 'var(--warn)' }} title={`${t.attempts} retries`}>
            ×{t.attempts}
          </span>
        )}

        {kind === 'buy' && t.sellStatus && t.sellStatus !== 'pending' && (
          <span className="font-mono text-[9px]" style={{ color: 'var(--bad)' }}>· auto-sold</span>
        )}

        <span style={{ flex: 1 }} />

        {t.txHash && (
          <a
            href={`https://solscan.io/tx/${t.txHash}`} target="_blank" rel="noopener"
            onClick={(e) => e.stopPropagation()}
            className="font-mono text-[9px]" style={{ color: 'var(--accent)' }}
          >
            {t.txHash.slice(0, 4)}…↗
          </a>
        )}
        <a
          href={`https://dexscreener.com/solana/${t.mint}`} target="_blank" rel="noopener"
          onClick={(e) => e.stopPropagation()}
          className="text-[9px]" style={{ color: 'var(--text-3)' }}
        >
          dex↗
        </a>
        <span className="font-mono text-[10px]" style={{ color: 'var(--text-3)', minWidth: 38, textAlign: 'right' }}>
          {new Date(t.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>

        {canSell && onManualSell && (
          <span onClick={(e) => e.stopPropagation()}>
            <button
              className="btn btn-ghost btn-sm"
              style={{ fontSize: 10, height: 22, padding: '0 7px' }}
              onClick={() => onManualSell(t.id)}
              disabled={selling}
            >
              {selling ? <Spinner size={9} /> : 'sell'}
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

/* ── Stat sub-component ─────────────────────────────────────────── */
function Stat({
  label,
  value,
  sub,
  valueColor,
}: {
  label: string;
  value: string;
  sub: string | null;
  valueColor?: string;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <div className="text-[9px]" style={{ color: 'var(--text-3)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
        {label}
      </div>
      <div
        className="font-mono text-[11px]"
        style={{
          color: valueColor ?? 'var(--text)',
          fontWeight: 600,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {value}
      </div>
      {sub && (
        <div className="font-mono text-[9px]" style={{ color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {sub}
        </div>
      )}
    </div>
  );
}
