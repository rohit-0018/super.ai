import { detectChain } from '../token-analysis/chain-detector';
import type { Chain } from './token-resolver.types';

export type ClassifiedInput =
  | { kind: 'address'; chain: Chain; value: string }
  | { kind: 'ticker'; symbol: string }
  | { kind: 'unresolvable' };

// A plausible ticker after the optional `$`. 1–15 alphanumerics. Most tickers
// are ALL-CAPS but users type lowercase; the resolver matches case-insensitively.
const TICKER_RE = /^[A-Za-z0-9]{1,15}$/;

/**
 * Classify a raw user string into an address, a ticker, or junk.
 *
 * Precedence:
 *   1. Leading `$` → force ticker (the documented disambiguator), strip it.
 *   2. Valid contract address (EVM 0x.. / Solana base58) → address.
 *   3. Bare alphanumeric ≥2 chars → ticker.
 *   4. Otherwise unresolvable.
 *
 * The `$` prefix exists precisely so a short string that *could* be a typo'd
 * address is unambiguously treated as a ticker.
 */
export function classifyInput(raw: string): ClassifiedInput {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { kind: 'unresolvable' };

  if (trimmed.startsWith('$')) {
    const symbol = trimmed.slice(1).trim();
    if (TICKER_RE.test(symbol)) return { kind: 'ticker', symbol };
    return { kind: 'unresolvable' };
  }

  const chain = detectChain(trimmed);
  if (chain) return { kind: 'address', chain, value: trimmed };

  // Bare ticker without `$`: require ≥2 chars so single-letter noise / partial
  // paste doesn't trigger a token search.
  if (trimmed.length >= 2 && TICKER_RE.test(trimmed)) {
    return { kind: 'ticker', symbol: trimmed };
  }

  return { kind: 'unresolvable' };
}
