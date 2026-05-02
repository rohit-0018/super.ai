'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useInView, useTokenDetail, type TokenDetail } from '../lib/useTokenDetail';
import SellTokenModal from './SellTokenModal';
import { fmtPriceUsd } from '../lib/format-price';

export interface HoldingRow {
  mint: string;
  symbol: string;
  amount: number;
  decimals: number;
  priceUsd: number | null;
  valueUsd: number | null;
  entryCostSol: number | null;
  entryCostUsd: number | null;
  pnlUsd: number | null;
  pnlPct: number | null;
  firstBoughtAt: string | null;
  txHash: string | null;
}

/* ── Formatters ─────────────────────────────────────────────────── */
function fmtCompact(n: number | null | undefined, prefix = ''): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${prefix}${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${prefix}${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${prefix}${(n / 1e3).toFixed(2)}K`;
  return `${prefix}${n.toFixed(2)}`;
}
function fmtUsdCompact(n: number | null | undefined): string {
  return fmtCompact(n, '$');
}
function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(2)}k`;
  // Sub-cent values use DexScreener subscript notation — never scientific.
  if (Math.abs(n) < 0.01 && n !== 0) return fmtPriceUsd(n);
  return `$${n.toFixed(2)}`;
}
function fmtAmt(n: number, dp?: number): string {
  const decimals = dp ?? (n < 1 ? 6 : 2);
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
function fmtPct(n: number | null | undefined): string | null {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}
function relTime(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

/* ── Logo ───────────────────────────────────────────────────────── */
function TokenLogo({ logoURI, symbol }: { logoURI: string | null; symbol: string }) {
  const [errored, setErrored] = useState(false);
  const showImg = logoURI && !errored;
  return (
    <div
      style={{
        width: 36,
        height: 36,
        borderRadius: '50%',
        flexShrink: 0,
        background: showImg ? 'var(--surface-2)' : 'color-mix(in srgb, var(--accent) 15%, var(--surface-2))',
        border: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 11,
        fontWeight: 700,
        color: 'var(--accent)',
        letterSpacing: '-0.02em',
        overflow: 'hidden',
      }}
    >
      {showImg ? (
        <img
          src={logoURI as string}
          alt={symbol}
          width={36}
          height={36}
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
export function PortfolioTokenRow({
  h,
  walletId,
  walletChain,
}: {
  h: HoldingRow;
  walletId: string;
  walletChain: 'SOLANA' | 'EVM';
}) {
  const [expanded, setExpanded] = useState(false);
  const [sellOpen, setSellOpen] = useState(false);
  const router = useRouter();
  const { ref, inView } = useInView<HTMLDivElement>();
  const { data: detail, loading: detailLoading } = useTokenDetail(h.mint, inView);

  // Hand the holding context to the AI chat so the user can ask "should I sell
  // this?" without re-typing every metric. The chat page reads ?prefill= from
  // the URL on mount.
  const askAi = (action: 'analyze' | 'sell' | 'buy') => {
    const sym = detail?.symbol ?? h.symbol;
    const prompt =
      action === 'sell'
        ? `Should I sell my ${sym}? I hold ${h.amount.toLocaleString()} ${sym} (mint ${h.mint}), avg cost $${h.entryCostUsd?.toFixed(2) ?? '?'}, current value $${(detail?.priceUsd ?? h.priceUsd ?? 0) * h.amount}. Run a fresh scan and give me a clear recommendation with reasoning.`
        : action === 'buy'
        ? `Should I buy more ${sym} (mint ${h.mint})? I currently hold ${h.amount.toLocaleString()} at avg cost $${h.entryCostUsd?.toFixed(2) ?? '?'}. Analyze the current setup and give me a sizing recommendation.`
        : `Analyze ${sym} (mint ${h.mint}) — I hold ${h.amount.toLocaleString()}, avg cost $${h.entryCostUsd?.toFixed(2) ?? '?'}. Give me a fresh deep-dive: market structure, on-chain risk, recent narrative, and whether I should hold, sell, or add.`;
    router.push(`/chat?prefill=${encodeURIComponent(prompt)}`);
  };

  // Prefer live Birdeye price (more recent than the bulk fetch in the list).
  const livePrice = detail?.priceUsd ?? h.priceUsd;
  const liveValue = livePrice !== null && livePrice !== undefined ? livePrice * h.amount : h.valueUsd;
  const livePnlUsd =
    liveValue !== null && liveValue !== undefined && h.entryCostUsd !== null
      ? liveValue - h.entryCostUsd
      : h.pnlUsd;
  const livePnlPct =
    livePnlUsd !== null && livePnlUsd !== undefined && h.entryCostUsd
      ? (livePnlUsd / h.entryCostUsd) * 100
      : h.pnlPct;

  const change24h = detail?.priceChange24hPct ?? null;
  const pnlColor =
    livePnlPct === null || livePnlPct === undefined
      ? 'var(--text-3)'
      : livePnlPct >= 0
        ? 'var(--ok)'
        : 'var(--bad)';
  const change24hColor =
    change24h === null ? 'var(--text-3)' : change24h >= 0 ? 'var(--ok)' : 'var(--bad)';

  const displayName = detail?.name ?? null;
  const displaySymbol = detail?.symbol ?? h.symbol;

  return (
    <div
      ref={ref}
      style={{
        borderBottom: '1px solid var(--border)',
        background: expanded ? 'var(--surface-2)' : 'transparent',
        transition: 'background 0.12s ease',
      }}
    >
      {/* Main row — clickable to expand */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        style={{
          width: '100%',
          display: 'grid',
          gridTemplateColumns: 'minmax(180px, 2fr) repeat(5, minmax(80px, 1fr)) auto',
          alignItems: 'center',
          gap: 12,
          padding: '10px 14px',
          background: 'transparent',
          border: 0,
          cursor: 'pointer',
          textAlign: 'left',
          color: 'inherit',
        }}
      >
        {/* Token cell */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <TokenLogo logoURI={detail?.logoURI ?? null} symbol={displaySymbol} />
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span className="text-[13px] font-semibold" style={{ whiteSpace: 'nowrap' }}>
                {displaySymbol}
              </span>
              {displayName && displayName !== displaySymbol && (
                <span
                  className="text-[11px]"
                  style={{
                    color: 'var(--text-3)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    maxWidth: 140,
                  }}
                >
                  {displayName}
                </span>
              )}
            </div>
            <div className="font-mono text-[10px]" style={{ color: 'var(--text-3)' }}>
              {h.mint.slice(0, 6)}…{h.mint.slice(-4)}
            </div>
          </div>
        </div>

        {/* Price + 24h */}
        <div style={{ textAlign: 'right' }}>
          <div className="font-mono text-[12px]">{fmtUsd(livePrice)}</div>
          {change24h !== null ? (
            <div className="font-mono text-[10px]" style={{ color: change24hColor }}>
              {fmtPct(change24h)}
            </div>
          ) : detailLoading ? (
            <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>
              …
            </div>
          ) : null}
        </div>

        {/* Market cap */}
        <div style={{ textAlign: 'right' }}>
          <div className="font-mono text-[12px]">{fmtUsdCompact(detail?.marketCap)}</div>
          <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>
            mcap
          </div>
        </div>

        {/* Liquidity */}
        <div style={{ textAlign: 'right' }}>
          <div className="font-mono text-[12px]">{fmtUsdCompact(detail?.liquidity)}</div>
          <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>
            liq
          </div>
        </div>

        {/* 24h volume */}
        <div style={{ textAlign: 'right' }}>
          <div className="font-mono text-[12px]">{fmtUsdCompact(detail?.volume24hUsd)}</div>
          <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>
            24h vol
          </div>
        </div>

        {/* Your value + PnL */}
        <div style={{ textAlign: 'right' }}>
          <div className="font-mono text-[13px] font-semibold">{fmtUsd(liveValue)}</div>
          {livePnlPct !== null && livePnlPct !== undefined ? (
            <div className="font-mono text-[10px] font-semibold" style={{ color: pnlColor }}>
              {fmtPct(livePnlPct)}
              {livePnlUsd !== null && livePnlUsd !== undefined && (
                <span style={{ opacity: 0.85, marginLeft: 4 }}>
                  ({livePnlUsd >= 0 ? '+' : ''}
                  {fmtUsd(livePnlUsd)})
                </span>
              )}
            </div>
          ) : (
            <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>
              cost {fmtUsd(h.entryCostUsd)}
            </div>
          )}
        </div>

        {/* Expand chevron */}
        <div
          style={{
            color: 'var(--text-3)',
            transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.15s ease',
            fontSize: 10,
            paddingLeft: 4,
          }}
        >
          ▾
        </div>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div
          style={{
            padding: '14px 18px 18px',
            borderTop: '1px solid var(--border)',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
            gap: 16,
            background: 'var(--surface-2)',
          }}
        >
          <DetailField label="Amount held" mono>
            {fmtAmt(h.amount, h.amount < 1 ? 6 : 4)} {displaySymbol}
          </DetailField>
          <DetailField label="Avg buy cost" mono>
            {fmtUsd(h.entryCostUsd)}
            {h.entryCostSol !== null && (
              <span style={{ color: 'var(--text-3)', fontSize: 10, marginLeft: 4 }}>
                ({h.entryCostSol.toFixed(3)} SOL)
              </span>
            )}
          </DetailField>
          <DetailField label="Avg buy price" mono>
            {h.entryCostUsd !== null && h.amount > 0 ? fmtUsd(h.entryCostUsd / h.amount) : '—'}
          </DetailField>
          <DetailField label="Current price" mono>
            {fmtUsd(livePrice)}
          </DetailField>
          <DetailField label="Current value" mono>
            {fmtUsd(liveValue)}
          </DetailField>
          <DetailField label="P&L" mono color={pnlColor}>
            {livePnlPct !== null && livePnlPct !== undefined ? fmtPct(livePnlPct) : '—'}
            {livePnlUsd !== null && livePnlUsd !== undefined && (
              <span style={{ marginLeft: 6, opacity: 0.8 }}>
                ({livePnlUsd >= 0 ? '+' : ''}
                {fmtUsd(livePnlUsd)})
              </span>
            )}
          </DetailField>
          <DetailField label="Market cap" mono>
            {fmtUsdCompact(detail?.marketCap)}
          </DetailField>
          <DetailField label="FDV" mono>
            {fmtUsdCompact(detail?.fdv)}
          </DetailField>
          <DetailField label="Liquidity" mono>
            {fmtUsdCompact(detail?.liquidity)}
          </DetailField>
          <DetailField label="Volume 24h" mono>
            {fmtUsdCompact(detail?.volume24hUsd)}
          </DetailField>
          <DetailField label="Supply" mono>
            {fmtCompact(detail?.supply)}
          </DetailField>
          <DetailField label="Holders" mono>
            {detail?.holders !== null && detail?.holders !== undefined
              ? detail.holders.toLocaleString('en-US')
              : '—'}
          </DetailField>
          <DetailField label="Bought">
            {relTime(h.firstBoughtAt)}
          </DetailField>
          <DetailField label="Mint" mono>
            <CopyMint mint={h.mint} />
          </DetailField>

          <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4, alignItems: 'center' }}>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setSellOpen(true);
              }}
              disabled={walletChain !== 'SOLANA' || h.amount <= 0}
              className="btn btn-primary"
              style={{
                fontSize: 12,
                padding: '6px 14px',
                fontWeight: 600,
              }}
              title={walletChain !== 'SOLANA' ? 'Selling supported on Solana wallets only' : `Sell ${h.symbol}`}
            >
              Sell {displaySymbol}
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); askAi('analyze'); }}
              className="btn btn-ghost"
              style={{ fontSize: 12, padding: '6px 12px', fontWeight: 600 }}
              title="Ask the AI agent for a fresh analysis with hold/sell/add recommendation"
            >
              🤖 Ask AI
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); askAi('sell'); }}
              className="btn btn-ghost"
              style={{ fontSize: 11, padding: '6px 10px', color: 'var(--bad)' }}
              title="Ask AI: should I sell?"
            >
              Sell?
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); askAi('buy'); }}
              className="btn btn-ghost"
              style={{ fontSize: 11, padding: '6px 10px', color: 'var(--ok)' }}
              title="Ask AI: should I buy more?"
            >
              Buy more?
            </button>
            <span style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 2px' }} />
            <ExternalLink href={`https://dexscreener.com/solana/${h.mint}`} label="DexScreener" />
            <ExternalLink href={`https://birdeye.so/token/${h.mint}?chain=solana`} label="Birdeye" />
            <ExternalLink href={`https://solscan.io/token/${h.mint}`} label="Solscan" />
            {h.txHash && (
              <ExternalLink href={`https://solscan.io/tx/${h.txHash}`} label="Buy tx" />
            )}
            <ExternalLink href={`https://jup.ag/swap/SOL-${h.mint}`} label="Trade on Jupiter" />
          </div>
        </div>
      )}

      {sellOpen && (
        <SellTokenModal
          walletId={walletId}
          walletChain={walletChain}
          token={{
            mint: h.mint,
            symbol: displaySymbol,
            amount: h.amount,
            decimals: h.decimals,
            priceUsd: livePrice ?? null,
          }}
          onClose={() => setSellOpen(false)}
        />
      )}
    </div>
  );
}

/* ── Sub-components ─────────────────────────────────────────────── */
function DetailField({
  label,
  children,
  mono,
  color,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
  color?: string;
}) {
  return (
    <div>
      <div
        className="text-[10px]"
        style={{
          color: 'var(--text-3)',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          marginBottom: 3,
        }}
      >
        {label}
      </div>
      <div
        className={mono ? 'font-mono' : ''}
        style={{ fontSize: 12, color: color ?? 'var(--text-1)', fontWeight: 600 }}
      >
        {children}
      </div>
    </div>
  );
}

function CopyMint({ mint }: { mint: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(mint).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="font-mono"
      style={{
        background: 'transparent',
        border: 0,
        color: copied ? 'var(--ok)' : 'var(--accent)',
        cursor: 'pointer',
        fontSize: 11,
        padding: 0,
      }}
      title="Copy mint address"
    >
      {copied ? '✓ copied' : `${mint.slice(0, 6)}…${mint.slice(-6)}`}
    </button>
  );
}

function ExternalLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener"
      onClick={(e) => e.stopPropagation()}
      className="text-[11px]"
      style={{
        padding: '4px 9px',
        borderRadius: 6,
        border: '1px solid var(--border)',
        background: 'var(--surface-1)',
        color: 'var(--text-2)',
        textDecoration: 'none',
        whiteSpace: 'nowrap',
      }}
    >
      {label} ↗
    </a>
  );
}
