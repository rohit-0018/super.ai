'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useApi, invalidate } from '../../lib/useApi';
import { Skeleton } from '../../components/ui/Skeleton';
import { PortfolioTokenRow, type HoldingRow } from '../../components/PortfolioTokenRow';

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

/* ── Helpers ───────────────────────────────────────────────────── */
function fmtUsd(n: number | null | undefined) {
  if (n === null || n === undefined) return '—';
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(2)}k`;
  return `$${n.toFixed(2)}`;
}

/* ── Per-wallet holdings panel ─────────────────────────────────── */
function WalletHoldings({
  wallet,
  nativeUsd,
  collapsed,
  onToggleCollapse,
}: {
  wallet: Wallet;
  nativeUsd: number | null;
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  const { data: holdings, loading, error } = useApi<HoldingRow[]>(`/wallets/${wallet.id}/holdings`);

  const totalValue = (holdings ?? []).reduce((s, h) => s + (h.valueUsd ?? 0), 0) + (nativeUsd ?? 0);
  const totalPnl   = (holdings ?? []).reduce((s, h) => s + (h.pnlUsd ?? 0), 0);

  return (
    <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
      {/* Wallet header — click to collapse/expand the token list */}
      <button
        type="button"
        onClick={onToggleCollapse}
        style={{
          width: '100%',
          padding: '12px 16px',
          borderBottom: collapsed ? 'none' : '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          background: 'linear-gradient(180deg, color-mix(in srgb, var(--accent) 5%, transparent), transparent)',
          border: 0,
          cursor: 'pointer',
          textAlign: 'left',
          color: 'inherit',
        }}
      >
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

        <div style={{
          color: 'var(--text-3)',
          fontSize: 12,
          transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
          transition: 'transform 0.15s ease',
          marginLeft: 6,
        }}>▾</div>
      </button>

      {/* Token table */}
      {collapsed ? null : loading ? (
        <div className="space-y-2 p-4">
          {[...Array(3)].map((_, i) => <Skeleton key={i} h={44} rounded="md" />)}
        </div>
      ) : error ? (
        <div style={{ padding: '20px 16px', textAlign: 'center' }}>
          <p className="text-[12px]" style={{ color: 'var(--bad)' }}>Failed to load holdings</p>
        </div>
      ) : (holdings ?? []).length === 0 ? (
        /* Compact, not a card. A full empty-state block per wallet turned a
           page with 11 empty wallets into ~1000px of identical placeholder —
           the emptiness is worth one line, not a hero treatment. */
        <div
          className="text-[11px]"
          style={{ padding: '8px 16px', color: 'var(--text-3)' }}
        >
          No tokens — they appear here once you snipe or receive them on-chain.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          {/* Column header — matches PortfolioTokenRow's grid */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(180px, 2fr) repeat(5, minmax(80px, 1fr)) auto',
              alignItems: 'center',
              gap: 12,
              padding: '8px 14px',
              background: 'var(--surface-2)',
              borderBottom: '1px solid var(--border)',
              fontSize: 10,
              fontWeight: 600,
              color: 'var(--text-3)',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              whiteSpace: 'nowrap',
            }}
          >
            <div>Token</div>
            <div style={{ textAlign: 'right' }}>Price · 24h</div>
            <div style={{ textAlign: 'right' }}>Mcap</div>
            <div style={{ textAlign: 'right' }}>Liquidity</div>
            <div style={{ textAlign: 'right' }}>Vol 24h</div>
            <div style={{ textAlign: 'right' }}>Value · P&amp;L</div>
            <div />
          </div>

          {(holdings ?? []).map((h) => (
            <PortfolioTokenRow
              key={h.mint}
              h={h}
              walletId={wallet.id}
              walletChain={wallet.chain}
            />
          ))}
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

  // Per-wallet collapse state — primary wallet stays open by default, others
  // start expanded too. Memoized in localStorage so user preference sticks.
  const [collapsedMap, setCollapsedMap] = useState<Record<string, boolean>>({});
  useEffect(() => {
    try {
      const raw = localStorage.getItem('qwai_portfolio_collapsed');
      if (raw) setCollapsedMap(JSON.parse(raw));
    } catch { /* ignore */ }
  }, []);
  const toggleCollapse = (walletId: string) => {
    setCollapsedMap((prev) => {
      const next = { ...prev, [walletId]: !prev[walletId] };
      try { localStorage.setItem('qwai_portfolio_collapsed', JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };

  // Refresh button + 1-hour auto-refresh. Invalidates every cached
  // /wallets/*/holdings entry plus the balances list, which causes useApi
  // subscribers to re-fetch immediately. Manual button shows "refreshing…"
  // while in flight so users get clear feedback.
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshAt, setLastRefreshAt] = useState<number>(Date.now());
  const refresh = async () => {
    setRefreshing(true);
    try {
      invalidate('/wallets/balances');
      for (const w of solWallets) invalidate(`/wallets/${w.id}/holdings`);
      // give the in-flight refetch a beat to land before flipping the spinner
      await new Promise((r) => setTimeout(r, 600));
      setLastRefreshAt(Date.now());
    } finally {
      setRefreshing(false);
    }
  };
  useEffect(() => {
    const HOUR = 60 * 60 * 1000;
    const id = setInterval(() => {
      invalidate('/wallets/balances');
      // Refresh holdings for each wallet
      const ws = (wallets ?? []).filter((w) => w.chain === 'SOLANA');
      for (const w of ws) invalidate(`/wallets/${w.id}/holdings`);
      setLastRefreshAt(Date.now());
    }, HOUR);
    return () => clearInterval(id);
  }, [wallets]);

  const minutesSinceRefresh = Math.floor((Date.now() - lastRefreshAt) / 60_000);
  const refreshLabel =
    minutesSinceRefresh < 1 ? 'just now' : `${minutesSinceRefresh}m ago`;

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

        {/* Total value + refresh control */}
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6,
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="text-[10px]" style={{ color: 'var(--text-3)' }}>
              Updated {refreshLabel}
            </span>
            <button
              type="button"
              onClick={refresh}
              disabled={refreshing}
              className="btn btn-sm"
              style={{
                fontSize: 11,
                padding: '4px 10px',
                opacity: refreshing ? 0.6 : 1,
                cursor: refreshing ? 'wait' : 'pointer',
              }}
              title="Re-fetch live prices and holdings"
            >
              {refreshing ? '⟳ refreshing…' : '↻ Refresh'}
            </button>
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
              collapsed={!!collapsedMap[w.id]}
              onToggleCollapse={() => toggleCollapse(w.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
