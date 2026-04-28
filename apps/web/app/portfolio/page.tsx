'use client';
import { useState, useCallback } from 'react';
import Link from 'next/link';
import { useApi, invalidate } from '../../lib/useApi';
import { Skeleton } from '../../components/ui/Skeleton';

/* ── Types ─────────────────────────────────────────────────────── */
interface Wallet {
  id: string;
  chain: 'SOLANA' | 'EVM';
  address: string;
  label: string | null;
  isPrimary?: boolean;
}

interface WalletBalance {
  walletId: string;
  native: number;
  symbol: string;
  usd: number;
  error?: string;
}

interface HoldingRow {
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

/* ── Helpers ───────────────────────────────────────────────────── */
function fmt(n: number | null | undefined, dp = 2, prefix = ''): string {
  if (n === null || n === undefined) return '—';
  return `${prefix}${n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}
function fmtUsd(n: number | null | undefined) {
  if (n === null || n === undefined) return '—';
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(2)}k`;
  return `$${n.toFixed(2)}`;
}
function fmtPct(n: number | null | undefined) {
  if (n === null || n === undefined) return null;
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}
function relTime(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

/* ── Token row ─────────────────────────────────────────────────── */
function TokenRow({ h }: { h: HoldingRow }) {
  const pnlColor = h.pnlPct === null ? 'var(--text-3)'
    : h.pnlPct >= 0 ? 'var(--ok)' : 'var(--bad)';
  const pnlStr = fmtPct(h.pnlPct);

  return (
    <tr style={{ borderBottom: '1px solid var(--border)' }}>
      {/* Token */}
      <td style={{ padding: '10px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
            background: `color-mix(in srgb, var(--accent) 15%, var(--surface-2))`,
            border: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 11, fontWeight: 700, color: 'var(--accent)',
            letterSpacing: '-0.02em',
          }}>
            {h.symbol.slice(0, 3).toUpperCase()}
          </div>
          <div>
            <div className="text-[13px] font-semibold">{h.symbol}</div>
            <div className="font-mono text-[10px]" style={{ color: 'var(--text-3)' }}>
              {h.mint.slice(0, 6)}…{h.mint.slice(-4)}
            </div>
          </div>
        </div>
      </td>

      {/* Amount */}
      <td style={{ padding: '10px 14px', textAlign: 'right' }}>
        <div className="font-mono text-[12px]">{fmt(h.amount, h.amount < 1 ? 6 : 2)}</div>
      </td>

      {/* Price */}
      <td style={{ padding: '10px 14px', textAlign: 'right' }}>
        <div className="font-mono text-[12px]">{fmtUsd(h.priceUsd)}</div>
      </td>

      {/* Value */}
      <td style={{ padding: '10px 14px', textAlign: 'right' }}>
        <div className="font-mono text-[13px] font-semibold">{fmtUsd(h.valueUsd)}</div>
        {h.entryCostUsd !== null && (
          <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>
            cost {fmtUsd(h.entryCostUsd)}
          </div>
        )}
      </td>

      {/* P&L */}
      <td style={{ padding: '10px 14px', textAlign: 'right' }}>
        {pnlStr ? (
          <div>
            <div className="font-mono text-[12px] font-semibold" style={{ color: pnlColor }}>
              {pnlStr}
            </div>
            {h.pnlUsd !== null && (
              <div className="font-mono text-[10px]" style={{ color: pnlColor, opacity: 0.8 }}>
                {h.pnlUsd >= 0 ? '+' : ''}{fmtUsd(h.pnlUsd)}
              </div>
            )}
          </div>
        ) : (
          <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>—</span>
        )}
      </td>

      {/* Bought */}
      <td style={{ padding: '10px 14px', textAlign: 'right' }}>
        <div className="text-[11px]" style={{ color: 'var(--text-3)' }}>{relTime(h.firstBoughtAt)}</div>
        {h.txHash && (
          <a
            href={`https://solscan.io/tx/${h.txHash}`}
            target="_blank" rel="noopener"
            className="font-mono text-[10px]"
            style={{ color: 'var(--accent)' }}
          >
            {h.txHash.slice(0, 6)}…↗
          </a>
        )}
      </td>
    </tr>
  );
}

/* ── Per-wallet holdings panel ─────────────────────────────────── */
function WalletHoldings({ wallet, nativeUsd }: { wallet: Wallet; nativeUsd: number | null }) {
  const { data: holdings, loading, error } = useApi<HoldingRow[]>(`/wallets/${wallet.id}/holdings`);

  const totalValue = (holdings ?? []).reduce((s, h) => s + (h.valueUsd ?? 0), 0) + (nativeUsd ?? 0);
  const totalPnl   = (holdings ?? []).reduce((s, h) => s + (h.pnlUsd ?? 0), 0);

  return (
    <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
      {/* Wallet header */}
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        background: 'linear-gradient(180deg, color-mix(in srgb, var(--accent) 5%, transparent), transparent)',
      }}>
        <div style={{
          width: 36, height: 36, borderRadius: 10, flexShrink: 0,
          background: 'color-mix(in srgb, var(--accent) 15%, var(--surface-2))',
          border: '1px solid color-mix(in srgb, var(--accent) 30%, var(--border))',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 16,
        }}>
          {wallet.chain === 'SOLANA' ? '◎' : 'Ξ'}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
            <span className="text-[14px] font-semibold">
              {wallet.label ?? `${wallet.chain} wallet`}
            </span>
            {wallet.isPrimary && (
              <span className="chip chip-accent" style={{ fontSize: 10 }}>Primary</span>
            )}
          </div>
          <div className="font-mono text-[11px]" style={{ color: 'var(--text-3)', marginTop: 2 }}>
            {wallet.address.slice(0, 10)}…{wallet.address.slice(-6)}
          </div>
        </div>

        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div className="font-mono text-[16px] font-bold">{fmtUsd(totalValue)}</div>
          <div style={{
            fontSize: 11, fontWeight: 600,
            color: totalPnl >= 0 ? 'var(--ok)' : 'var(--bad)',
            marginTop: 1,
          }}>
            {totalPnl !== 0 && (totalPnl >= 0 ? '+' : '')}{fmtUsd(totalPnl)} P&L
          </div>
        </div>
      </div>

      {/* Token table */}
      {loading ? (
        <div className="space-y-2 p-4">
          {[...Array(3)].map((_, i) => <Skeleton key={i} h={44} rounded="md" />)}
        </div>
      ) : error ? (
        <div style={{ padding: '20px 16px', textAlign: 'center' }}>
          <p className="text-[12px]" style={{ color: 'var(--bad)' }}>Failed to load holdings</p>
        </div>
      ) : (holdings ?? []).length === 0 ? (
        <div style={{ padding: '28px 16px', textAlign: 'center' }}>
          <div style={{ fontSize: 28, marginBottom: 10, opacity: 0.4 }}>◎</div>
          <p className="text-[13px] font-medium" style={{ color: 'var(--text-2)' }}>No tokens found</p>
          <p className="text-[11px] mt-1" style={{ color: 'var(--text-3)' }}>
            Tokens appear here once you snipe or receive them on-chain.
          </p>
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['Token', 'Amount', 'Price', 'Value', 'P&L', 'Bought'].map((h, i) => (
                  <th key={h} style={{
                    padding: '8px 14px',
                    textAlign: i === 0 ? 'left' : 'right',
                    fontSize: 10, fontWeight: 600,
                    color: 'var(--text-3)',
                    letterSpacing: '0.08em', textTransform: 'uppercase',
                    background: 'var(--surface-2)',
                    whiteSpace: 'nowrap',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(holdings ?? []).map((h) => <TokenRow key={h.mint} h={h} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ── Page ───────────────────────────────────────────────────────── */
export default function PortfolioPage() {
  const { data: wallets, loading: wLoading } = useApi<Wallet[]>('/wallets');
  const { data: balances } = useApi<WalletBalance[]>('/wallets/balances');

  const balMap = new Map<string, WalletBalance>();
  balances?.forEach((b) => balMap.set(b.walletId, b));

  const totalPortfolioUsd = balances?.reduce((s, b) => s + (b.usd ?? 0), 0) ?? 0;
  const solWallets = (wallets ?? []).filter((w) => w.chain === 'SOLANA');

  if (wLoading) {
    return (
      <div className="page space-y-4">
        <div className="page-header"><Skeleton w={180} h={28} /></div>
        <div className="space-y-4">
          {[...Array(2)].map((_, i) => (
            <div key={i} className="panel space-y-3 p-4">
              <Skeleton h={44} rounded="md" />
              {[...Array(3)].map((_, j) => <Skeleton key={j} h={52} rounded="md" />)}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="page space-y-4">
      <header className="page-header">
        <div>
          <div className="section-eyebrow">Wallet</div>
          <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 22 }}>◎</span>
            Portfolio
          </h1>
          <p className="page-subtitle">
            Live token holdings per wallet · prices via Birdeye · P&L from snipe history.
          </p>
        </div>

        {/* Total value badge */}
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4,
        }}>
          <div style={{
            fontSize: 11, fontWeight: 600, letterSpacing: '0.1em',
            color: 'var(--text-3)', textTransform: 'uppercase',
          }}>Total value</div>
          <div className="font-mono text-[24px] font-bold" style={{
            background: 'linear-gradient(135deg, var(--accent), var(--accent-2))',
            WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
          }}>
            {fmtUsd(totalPortfolioUsd)}
          </div>
        </div>
      </header>

      {/* Summary strip */}
      <div style={{
        display: 'flex', gap: 12, flexWrap: 'wrap',
        padding: '10px 14px', borderRadius: 10,
        background: 'var(--surface-2)', border: '1px solid var(--border)',
      }}>
        {balances?.map((b) => {
          const w = wallets?.find((ww) => ww.id === b.walletId);
          return (
            <div key={b.walletId} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13, opacity: 0.6 }}>{b.symbol === 'SOL' ? '◎' : 'Ξ'}</span>
              <span className="font-mono text-[12px]" style={{ color: 'var(--text-2)' }}>
                {b.native.toFixed(4)} {b.symbol}
              </span>
              <span className="font-mono text-[12px] font-semibold">{fmtUsd(b.usd)}</span>
              {w?.label && <span className="text-[10px]" style={{ color: 'var(--text-3)' }}>· {w.label}</span>}
            </div>
          );
        })}
        {(balances?.length ?? 0) === 0 && (
          <span className="text-[12px]" style={{ color: 'var(--text-3)' }}>No balance data yet</span>
        )}
      </div>

      {/* Per-wallet holdings */}
      {solWallets.length === 0 ? (
        <div className="panel" style={{ padding: '32px 24px', textAlign: 'center' }}>
          <div style={{ fontSize: 40, marginBottom: 12, opacity: 0.3 }}>◎</div>
          <p className="text-[14px] font-semibold" style={{ color: 'var(--text-2)' }}>No Solana wallets yet</p>
          <p className="text-[12px] mt-2" style={{ color: 'var(--text-3)' }}>
            Create a wallet on the{' '}
            <Link href="/wallets" style={{ color: 'var(--accent)' }}>Wallets page</Link>
            {' '}to start tracking holdings.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {solWallets.map((w) => (
            <WalletHoldings
              key={w.id}
              wallet={w}
              nativeUsd={balMap.get(w.id)?.usd ?? null}
            />
          ))}
        </div>
      )}
    </div>
  );
}
