'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { ChainBadge } from './ui/ChainBadge';
import { chainTitle, type WalletGroup, type WalletLike } from '../lib/wallet-groups';

/**
 * Collapsible header for one wallet group.
 *
 * Carries the group's identity (chain badge + title) and its money on the same
 * line, because the reason to group wallets at all is to answer "how much is in
 * my sniper set / on Base" without opening anything.
 *
 * Collapse state persists per group key so a user who keeps a large set folded
 * away does not have to re-fold it after every navigation.
 */
export function WalletGroupSection({
  group,
  children,
  onFund,
  onCollect,
  scopeLabel,
}: {
  group: WalletGroup<WalletLike & Record<string, any>>;
  children: ReactNode;
  onFund?: (walletIds: string[]) => void;
  onCollect?: (walletIds: string[]) => void;
  scopeLabel?: string;
}) {
  const [open, setOpen] = useState(true);

  const storageKey = `qwai_wgroup_${group.key}`;
  useEffect(() => {
    try {
      if (localStorage.getItem(storageKey) === 'closed') setOpen(false);
    } catch {
      /* localStorage unavailable — default to open */
    }
  }, [storageKey]);

  const toggle = () => {
    setOpen((v) => {
      const next = !v;
      try {
        localStorage.setItem(storageKey, next ? 'open' : 'closed');
      } catch {
        /* non-fatal */
      }
      return next;
    });
  };

  const count = group.wallets.length;
  // Bulk transfers need a counterparty inside the group to be meaningful.
  const canBulk = count >= 2;

  return (
    <div
      style={{
        borderTop: '1px solid var(--border)',
        background: open ? 'transparent' : 'var(--bg-2)',
      }}
    >
      <div
        className="flex items-center gap-3 flex-wrap"
        style={{ padding: '9px 14px', background: 'var(--surface-2)' }}
      >
        <button
          onClick={toggle}
          aria-expanded={open}
          aria-label={open ? `Collapse ${group.title}` : `Expand ${group.title}`}
          className="flex items-center gap-2 min-w-0"
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, flex: 1 }}
        >
          <Chevron open={open} />
          {/* Every group states its chains. In Set mode a group has no single
              chain, so we show the cluster it actually spans — without this the
              header gave no clue whether "snipe" was Solana or EVM. */}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
            {(group.chains.length ? group.chains : group.chain ? [group.chain] : [])
              .slice(0, 4)
              .map((c) => (
                <ChainBadge key={c} chain={c} size="xs" showLabel={false} />
              ))}
          </span>
          <span
            className="text-body font-semibold"
            style={{ color: 'var(--text)', whiteSpace: 'nowrap' }}
          >
            {group.title}
          </span>
          {!group.chain && group.chains.length > 0 && (
            <span className="text-[10px]" style={{ color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
              {group.chains.slice(0, 2).map(chainTitle).join(' · ')}
              {group.chains.length > 2 ? ` +${group.chains.length - 2}` : ''}
            </span>
          )}
          <span
            className="font-mono text-xs"
            style={{ color: 'var(--text-3)', fontFeatureSettings: "'tnum' 1" }}
          >
            {count}
          </span>

          {group.needsBackup && (
            <span
              className="chip"
              style={{
                color: 'var(--warn)',
                borderColor: 'color-mix(in srgb, var(--warn) 40%, var(--border))',
                fontSize: 10,
              }}
              title="At least one wallet in this group has no key backup"
            >
              backup
            </span>
          )}
        </button>

        <div className="flex items-center gap-3">
          {/* Funded-vs-total is the signal that matters before a bulk action:
              it tells you how many wallets actually have something in them. */}
          {count > 1 && (
            <span className="font-mono text-[10px]" style={{ color: 'var(--text-3)' }}>
              {group.fundedCount}/{count} funded
            </span>
          )}
          <span
            className="font-mono text-sm font-semibold"
            style={{ fontFeatureSettings: "'tnum' 1", color: 'var(--text)' }}
            title={scopeLabel ? `Value on ${scopeLabel}` : undefined}
          >
            ${group.totalUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </span>

          {canBulk && (onFund || onCollect) && (
            <div className="flex items-center gap-1">
              {onFund && (
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ fontSize: 10, height: 22, padding: '0 7px' }}
                  onClick={() => onFund(group.wallets.map((w) => w.id))}
                  title={`Fund the ${group.title} wallets`}
                >
                  Fund
                </button>
              )}
              {onCollect && (
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ fontSize: 10, height: 22, padding: '0 7px' }}
                  onClick={() => onCollect(group.wallets.map((w) => w.id))}
                  title={`Sweep the ${group.title} wallets into one`}
                >
                  Collect
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {open && <ul className="divide-y divide-border fade-in">{children}</ul>}
    </div>
  );
}

/** Group-by control. Sits in the Wallets section header. */
export function GroupModeToggle({
  mode,
  onChange,
}: {
  mode: 'chain' | 'set' | 'none';
  onChange: (m: 'chain' | 'set' | 'none') => void;
}) {
  const opts: Array<{ key: 'chain' | 'set' | 'none'; label: string; title: string }> = [
    { key: 'chain', label: 'Chain', title: 'Group by chain' },
    { key: 'set', label: 'Set', title: 'Group by label — "Sniper 1…N" becomes one set' },
    { key: 'none', label: 'Flat', title: 'No grouping' },
  ];
  return (
    <div className="flex items-center gap-0.5">
      <span className="text-[10px] mr-1" style={{ color: 'var(--text-3)' }}>
        group
      </span>
      {opts.map((o) => (
        <button
          key={o.key}
          onClick={() => onChange(o.key)}
          title={o.title}
          className="btn btn-sm"
          style={{
            fontSize: 10,
            height: 22,
            padding: '0 8px',
            background: mode === o.key ? 'var(--surface-hover)' : 'transparent',
            border: `1px solid ${mode === o.key ? 'var(--border-2)' : 'transparent'}`,
            color: mode === o.key ? 'var(--text)' : 'var(--text-3)',
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      style={{
        color: 'var(--text-3)',
        flexShrink: 0,
        transform: open ? 'none' : 'rotate(-90deg)',
        transition: 'transform 120ms',
      }}
    >
      <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
