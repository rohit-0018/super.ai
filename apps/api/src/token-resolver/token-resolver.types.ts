import type { Chain } from '../token-analysis/token-analysis.types';

export type { Chain };

/**
 * How a candidate matched the user's query.
 * `address` — the input was a contract address, resolved directly.
 * `exact`   — baseToken.symbol === query (case-insensitive).
 * `prefix`  — baseToken.symbol startsWith query.
 * `fuzzy`   — baseToken.symbol includes query (name match etc).
 * Sort is (matchTier rank desc, score desc) so an exact symbol match always
 * outranks a fuzzy one regardless of how big the fuzzy token is.
 */
export type MatchTier = 'address' | 'exact' | 'prefix' | 'fuzzy';

export interface ResolvedToken {
  chain: Chain;
  chainId: string; // dexscreener-style: solana|ethereum|base|bsc...
  address: string;
  symbol: string;
  name: string;
  priceUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  pairAgeHours: number | null;
  txns24h: number | null;
  logoURI: string | null;
  url: string | null; // dexscreener pair url
  verified: boolean; // listed on CoinGecko (canonical-ish)
  cgRank: number | null; // CoinGecko market-cap rank (1 = BTC, null = unknown)
  score: number;
  matchTier: MatchTier;
}

export type ResolveKind = 'address' | 'ticker' | 'unresolvable';

export interface ResolveResult {
  kind: ResolveKind;
  query: string; // normalized (no $ prefix, trimmed)
  best: ResolvedToken | null;
  candidates: ResolvedToken[]; // ranked; best === candidates[0] when present
  ambiguous: boolean; // more than one candidate
  /** 0..1 dominance of #1 vs #2 by score. 1 when only one candidate. */
  confidence: number;
}

export interface ResolveOptions {
  /** Constrain results to a chain (e.g. /pf is Solana-only). */
  chain?: Chain;
  /** Max candidates returned (default 8). */
  limit?: number;
  /** Drop candidates below this aggregated liquidity (USD). */
  minLiquidityUsd?: number;
}
