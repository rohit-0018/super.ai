'use client';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNetwork, type NetworkOption } from '../lib/NetworkContext';

/**
 * Network chooser for the top statusbar.
 *
 * Sits left of the paper/live pill because it is a *scope* control, not a mode
 * control — it changes what data you are looking at across the whole app.
 * Follows the card grammar: surface fill, 1px soft border, inner top highlight.
 */
export default function NetworkChooser() {
  const { network, setNetwork, options, selected, loading } = useNetwork();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  /**
   * The menu is portalled to <body> and positioned with `fixed`.
   *
   * This is required, not stylistic: `.statusbar` sets `overflow: hidden` (to
   * stop the ticker bleeding on narrow screens), which clips any absolutely
   * positioned child. Rendering the panel in-place made it invisible — it was
   * mounted and interactive, just cropped to zero height.
   */
  const place = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right) });
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    // Reposition rather than close: the shell can scroll under the fixed bar.
    const onMove = () => place();

    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open, place]);

  const label = selected?.name ?? (network === 'all' ? 'All Networks' : network);

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        className="chip cursor-pointer transition-colors"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Choose network"
        style={{
          gap: 7,
          borderColor: open ? 'var(--border-2)' : 'var(--border)',
          background: 'var(--surface)',
          maxWidth: 180,
        }}
      >
        <NetworkGlyph network={network} />
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: 'var(--text)',
          }}
        >
          {loading ? 'Networks…' : label}
        </span>
        <IconChevron open={open} />
      </button>

      {open && pos && typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            className="fade-in"
            style={{
              position: 'fixed',
              top: pos.top,
              right: pos.right,
              zIndex: 200,
              width: 268,
              maxHeight: 'min(420px, calc(100vh - 80px))',
              overflowY: 'auto',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              boxShadow: 'inset 0 1px 0 var(--highlight), 0 8px 24px rgba(0,0,0,0.45)',
              padding: 6,
            }}
          >
            {options.length === 0 && (
              <div className="text-xs" style={{ color: 'var(--text-3)', padding: '10px' }}>
                Loading networks…
              </div>
            )}

            {options.map((o) => (
              <NetworkRow
                key={o.key}
                opt={o}
                active={o.key === network}
                onPick={() => {
                  setNetwork(o.key);
                  setOpen(false);
                }}
              />
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}

function NetworkRow({
  opt,
  active,
  onPick,
}: {
  opt: NetworkOption;
  active: boolean;
  onPick: () => void;
}) {
  return (
    <button
      role="option"
      aria-selected={active}
      onClick={onPick}
      className="w-full transition-colors"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 10px',
        borderRadius: 8,
        background: active ? 'var(--surface-2)' : 'transparent',
        border: '1px solid ' + (active ? 'var(--border-2)' : 'transparent'),
        cursor: 'pointer',
        textAlign: 'left',
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = 'var(--surface-hover)';
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = 'transparent';
      }}
    >
      <NetworkGlyph network={opt.key} />

      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          className="text-body"
          style={{
            display: 'block',
            color: active ? 'var(--text)' : 'var(--text-2)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {opt.name}
        </span>
        {opt.nativeSymbol && (
          <span className="text-xs" style={{ color: 'var(--text-3)' }}>
            {opt.nativeSymbol}
            {opt.evmChainId ? ` · ${opt.evmChainId}` : ''}
          </span>
        )}
      </span>

      {/* Token count is the whole reason to open this menu — it tells you where
          the flow actually is right now. Mono + tnum so the column stays aligned. */}
      <span
        className="font-mono text-xs"
        style={{
          color: opt.count > 0 ? 'var(--text-2)' : 'var(--text-3)',
          fontFeatureSettings: "'tnum' 1",
        }}
      >
        {opt.count}
      </span>

      {active && <IconCheck />}
    </button>
  );
}

/**
 * Per-chain colour dot. Deliberately a small geometric mark rather than a logo
 * image — no external asset fetches, and it survives the CSP on any surface.
 */
function NetworkGlyph({ network }: { network: string }) {
  if (network === 'all') {
    return (
      <span
        style={{
          width: 10,
          height: 10,
          borderRadius: 3,
          flexShrink: 0,
          background:
            'conic-gradient(from 140deg, #9945FF, #14F195, #3b82f6, #F0B90B, #E84142, #9945FF)',
        }}
      />
    );
  }
  return (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: 999,
        flexShrink: 0,
        background: CHAIN_DOT[network] ?? 'var(--text-3)',
      }}
    />
  );
}

/** Brand-recognisable chain colours. Ornament only — never the sole signal. */
const CHAIN_DOT: Record<string, string> = {
  solana: '#14F195',
  ethereum: '#627EEA',
  bsc: '#F0B90B',
  base: '#0052FF',
  arbitrum: '#12AAFF',
  polygon: '#8247E5',
  avalanche: '#E84142',
  optimism: '#FF0420',
  blast: '#FCFC03',
};

function IconChevron({ open }: { open: boolean }) {
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
        transform: open ? 'rotate(180deg)' : 'none',
        transition: 'transform 120ms',
      }}
    >
      <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      style={{ color: 'var(--accent)', flexShrink: 0 }}
    >
      <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
