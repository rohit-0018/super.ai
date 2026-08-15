'use client';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useNetwork } from '../lib/NetworkContext';
import { ChainBadge } from './ui/ChainBadge';
import { Skeleton } from './ui/Skeleton';

/**
 * Token holdings for a single wallet, revealed inline under its row.
 *
 * Inline rather than a separate route: the point of the wallets screen is
 * comparing wallets, and navigating away to inspect one loses that context.
 * Fetching is lazy — only when opened — because holdings hit RPCs per wallet
 * and eagerly loading 11 of them would make the page crawl.
 */

export interface Holding {
  chain?: string;
  chainName?: string;
  isNative?: boolean;
  mint: string;
  symbol: string;
  amount: number;
  decimals: number;
  priceUsd: number | null;
  valueUsd: number | null;
  pnlUsd: number | null;
  pnlPct: number | null;
  firstBoughtAt: string | null;
  txHash: string | null;
}

export function WalletTokens({
  walletId,
  chainFamily,
}: {
  walletId: string;
  chainFamily: 'SOLANA' | 'EVM';
}) {
  const { network, isAll } = useNetwork();
  const [rows, setRows] = useState<Holding[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Scope the EVM lookup to the chosen chain. Unscoped, the API probes every
  // chain the wallet holds gas on, which is correct but slower.
  const chainParam = !isAll && chainFamily === 'EVM' ? `?chain=${encodeURIComponent(network)}` : '';

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .get<Holding[]>(`/wallets/${walletId}/holdings${chainParam}`)
      .then((res) => {
        if (!cancelled) setRows(Array.isArray(res.data) ? res.data : []);
      })
      .catch((e: any) => {
        if (!cancelled) setError(e?.response?.data?.message ?? e?.message ?? 'Could not load tokens');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [walletId, chainParam]);

  if (loading) {
    return (
      <div className="mt-2.5 flex flex-col gap-1.5" style={panelStyle}>
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="flex items-center justify-between">
            <Skeleton w={120} h={12} />
            <Skeleton w={70} h={12} />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="mt-2.5 text-[11px]" style={{ ...panelStyle, color: 'var(--bad)' }}>
        {error}
      </div>
    );
  }

  if (!rows || rows.length === 0) {
    return (
      <div className="mt-2.5 text-[11px]" style={{ ...panelStyle, color: 'var(--text-3)' }}>
        No tokens held
        {chainFamily === 'EVM' && (
          <span>
            {' '}· ERC-20s are matched against tokens you have traded, since public RPCs cannot
            list a wallet&apos;s holdings
          </span>
        )}
      </div>
    );
  }

  const total = rows.reduce((s, r) => s + (r.valueUsd ?? 0), 0);

  return (
    <div className="mt-2.5" style={panelStyle}>
      <div
        className="flex items-center justify-between mb-1.5"
        style={{ paddingBottom: 6, borderBottom: '1px solid var(--border)' }}
      >
        <span className="text-[10px]" style={{ color: 'var(--text-3)', letterSpacing: '0.08em' }}>
          {rows.length} TOKEN{rows.length === 1 ? '' : 'S'}
        </span>
        {total > 0 && (
          <span
            className="font-mono text-[11px]"
            style={{ color: 'var(--text-2)', fontFeatureSettings: "'tnum' 1" }}
          >
            ${total.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-1">
        {rows.map((r) => (
          <div
            key={`${r.chain ?? 'solana'}-${r.mint}`}
            className="flex items-center gap-2 justify-between"
          >
            <div className="flex items-center gap-2 min-w-0">
              {r.chain && <ChainBadge chain={r.chain} size="xs" showLabel={false} />}
              <span
                className="font-mono text-[11px] font-semibold"
                style={{ color: 'var(--text)' }}
              >
                {r.symbol}
              </span>
              {r.isNative && (
                <span className="text-[9px]" style={{ color: 'var(--text-3)' }}>
                  gas
                </span>
              )}
            </div>

            <div className="flex items-center gap-3 shrink-0">
              <span
                className="font-mono text-[11px]"
                style={{ color: 'var(--text-2)', fontFeatureSettings: "'tnum' 1" }}
              >
                {r.amount.toLocaleString(undefined, { maximumFractionDigits: 4 })}
              </span>
              <span
                className="font-mono text-[11px]"
                style={{
                  color: 'var(--text-3)',
                  minWidth: 62,
                  textAlign: 'right',
                  fontFeatureSettings: "'tnum' 1",
                }}
              >
                {/* An unpriced token shows "—", never a guessed number. */}
                {r.valueUsd == null ? '—' : `$${r.valueUsd.toFixed(2)}`}
              </span>
              {r.pnlPct != null && (
                <span
                  className="font-mono text-[10px]"
                  style={{
                    color: r.pnlPct >= 0 ? 'var(--ok)' : 'var(--bad)',
                    minWidth: 46,
                    textAlign: 'right',
                    fontFeatureSettings: "'tnum' 1",
                  }}
                >
                  {r.pnlPct >= 0 ? '+' : ''}
                  {r.pnlPct.toFixed(1)}%
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  background: 'var(--surface-2)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: '9px 11px',
};

/** Toggle placed in a wallet row's action bar. */
export function TokensButton({ open, count, onClick }: { open: boolean; count?: number; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="btn btn-ghost btn-sm"
      aria-expanded={open}
      style={{ fontSize: 11, gap: 5 }}
      title={open ? 'Hide tokens' : 'Show tokens held by this wallet'}
    >
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        style={{ transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform 120ms' }}
      >
        <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Tokens
      {count != null && count > 0 && (
        <span className="font-mono" style={{ color: 'var(--text-3)' }}>
          {count}
        </span>
      )}
    </button>
  );
}
