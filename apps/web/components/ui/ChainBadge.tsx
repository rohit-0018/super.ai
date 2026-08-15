'use client';
import { chainColor, chainName } from '../../lib/useNetworkFeed';

/**
 * Chain identity marker.
 *
 * Shown only when the view spans multiple chains — once you have scoped to
 * Base, stamping "Base" on all 40 rows is noise. Callers pass `show={isAll}`.
 *
 * Colour is ornament, never the sole signal: the label carries the meaning, so
 * this stays readable for colour-blind users and in high-contrast modes.
 */
export function ChainBadge({
  chain,
  size = 'sm',
  showLabel = true,
}: {
  chain: string;
  size?: 'xs' | 'sm';
  showLabel?: boolean;
}) {
  const color = chainColor(chain);
  const dot = size === 'xs' ? 5 : 6;

  return (
    <span
      title={chainName(chain)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        flexShrink: 0,
        padding: showLabel ? '1px 6px 1px 5px' : 0,
        borderRadius: 999,
        border: showLabel ? '1px solid var(--border)' : 'none',
        background: showLabel ? 'var(--surface-2)' : 'transparent',
        fontSize: size === 'xs' ? 9 : 10,
        fontWeight: 500,
        letterSpacing: '0.02em',
        color: 'var(--text-3)',
        lineHeight: 1.6,
      }}
    >
      <span
        style={{
          width: dot,
          height: dot,
          borderRadius: 999,
          background: color,
          flexShrink: 0,
        }}
      />
      {showLabel && chainName(chain)}
    </span>
  );
}

/**
 * Thin coloured rule used as a left edge on cards, so a scanned column of rows
 * reads as chain-grouped without adding another badge to every line.
 */
export function ChainEdge({ chain }: { chain: string }) {
  return (
    <span
      aria-hidden
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        bottom: 0,
        width: 2,
        borderRadius: '2px 0 0 2px',
        background: chainColor(chain),
        opacity: 0.65,
      }}
    />
  );
}
