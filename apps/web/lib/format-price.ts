/**
 * Human-friendly price formatting — never returns scientific notation.
 *
 * Mirrors apps/api/src/common/format-price.ts. We duplicate rather than
 * import across the workspace boundary because the static export bundle
 * has no easy path to the api/ tree.
 *
 * Format examples (DexScreener / Birdeye convention):
 *   1.23         →  $1.23
 *   0.0123       →  $0.0123
 *   0.000123     →  $0.000123
 *   0.0000536    →  $0.0₃536      (3 extra zeros after "0.0", then 3 sig figs)
 *   1.25e-9      →  $0.0₈125
 */

const SUBSCRIPTS = ['₀', '₁', '₂', '₃', '₄', '₅', '₆', '₇', '₈', '₉'];

function toSubscript(n: number): string {
  return String(n).split('').map((d) => SUBSCRIPTS[Number(d)] ?? d).join('');
}

export function fmtPriceUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (v === 0) return '$0';

  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);

  if (abs >= 1)      return `${sign}$${abs.toFixed(2)}`;
  if (abs >= 0.01)   return `${sign}$${abs.toFixed(4)}`;
  if (abs >= 0.0001) return `${sign}$${abs.toFixed(6)}`;

  const fixed = abs.toFixed(20);
  const dot = fixed.indexOf('.');
  const after = dot >= 0 ? fixed.slice(dot + 1) : fixed;
  const m = after.match(/^(0+)(\d+?)0*$/);
  if (!m) return `${sign}$${abs.toFixed(8)}`;

  const leadingZeros = m[1].length;
  const sigFigs = m[2].slice(0, 4) || '0';
  const extra = Math.max(0, leadingZeros - 1);
  return `${sign}$0.0${toSubscript(extra)}${sigFigs}`;
}

export function fmtUsdCompact(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `${v < 0 ? '-' : ''}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000)     return `${v < 0 ? '-' : ''}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000)         return `${v < 0 ? '-' : ''}$${(abs / 1_000).toFixed(1)}K`;
  return fmtPriceUsd(v);
}
