/**
 * Human-friendly price formatting — never returns scientific notation.
 *
 * Memecoin prices regularly drop below $0.0001 where naive `toFixed(2)` is
 * useless ("$0.00") and `toExponential` is unreadable ("5.36e-5"). Use the
 * DexScreener / Birdeye convention with Unicode subscript zeros instead:
 *
 *   0.0000536    →  $0.0₃536        (3 extra zeros after "0.0", then "536")
 *   0.00000000125 → $0.0₈125        (8 extra zeros, then "125")
 *
 * Subscripts render correctly in Telegram, browsers, and any modern terminal.
 *
 * Tiers:
 *   |v| ≥ 1       — 2 decimals  ($1.23)
 *   |v| ≥ 0.01    — 4 decimals  ($0.0123)
 *   |v| ≥ 0.0001  — 6 decimals  ($0.000123)
 *   |v| <  0.0001 — subscript notation ($0.0ₙ123)
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

  // Sub-$0.0001 — DexScreener subscript convention.
  const fixed = abs.toFixed(20);
  const dot = fixed.indexOf('.');
  const after = dot >= 0 ? fixed.slice(dot + 1) : fixed;
  const m = after.match(/^(0+)(\d+?)0*$/);
  if (!m) return `${sign}$${abs.toFixed(8)}`;

  const leadingZeros = m[1].length;
  const sigFigs = m[2].slice(0, 4) || '0';
  // Convention: "$0.0" already shows one zero, subscript counts the rest.
  const extra = Math.max(0, leadingZeros - 1);
  return `${sign}$0.0${toSubscript(extra)}${sigFigs}`;
}

/** Generic compact USD format ($1.23 / $1.23k / $1.23M / $1.23B / sub-cent subscript). */
export function fmtUsdCompact(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `${v < 0 ? '-' : ''}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000)     return `${v < 0 ? '-' : ''}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000)         return `${v < 0 ? '-' : ''}$${(abs / 1_000).toFixed(1)}K`;
  return fmtPriceUsd(v);
}
