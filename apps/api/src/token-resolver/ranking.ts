import type { MatchTier, ResolvedToken } from './token-resolver.types';

/**
 * Popularity scoring for ticker resolution. DexScreener-first: on-chain
 * liquidity / volume / age are the source of truth; CoinGecko listing is only
 * a small nudge. Pure + deterministic so it can be unit-tested in isolation.
 */

export interface ScoreInput {
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  marketCapUsd: number | null;
  txns24h: number | null;
  pairAgeHours: number | null;
  verified: boolean;
  cgRank?: number | null; // CoinGecko market-cap rank; 1 = BTC
}

// log10 compresses orders of magnitude so a 100x bigger token doesn't 100x
// outrank — keeps the long tail visible instead of one blue-chip burying all.
const log = (v: number | null): number => Math.log10(1 + Math.max(0, v ?? 0));

const W_LIQ = 1.0; // hardest-to-fake popularity signal
const W_VOL = 0.6;
const W_MC = 0.4;
const W_TX = 0.3;
const W_AGE = 0.3;
const W_VERIFIED = 1.0;
const W_CG_RANK = 3.0; // top-ranked CG coin pinned to #1 (rank 1→+3, rank 100→+1.5)

const AGE_CAP_HOURS = 720; // ~30d — older than this gives no extra credit

export function scoreToken(i: ScoreInput): number {
  const ageBoost = Math.min(Math.max(0, i.pairAgeHours ?? 0) / AGE_CAP_HOURS, 1);
  // Compress CG rank so rank-1 = full W_CG_RANK, rank-1000 = 0
  const cgBoost = i.cgRank != null
    ? W_CG_RANK * Math.max(0, 1 - Math.log10(i.cgRank + 1) / Math.log10(1001))
    : 0;
  return (
    log(i.liquidityUsd) * W_LIQ +
    log(i.volume24hUsd) * W_VOL +
    log(i.marketCapUsd) * W_MC +
    log(i.txns24h) * W_TX +
    ageBoost * W_AGE +
    (i.verified ? W_VERIFIED : 0) +
    cgBoost
  );
}

/** Higher rank wins. An exact symbol match always beats prefix/fuzzy. */
export const MATCH_TIER_RANK: Record<MatchTier, number> = {
  address: 4,
  exact: 3,
  prefix: 2,
  fuzzy: 1,
};

/**
 * Sort candidates: match-tier first (exact > prefix > fuzzy), then score.
 * Returns a new array; does not mutate the input.
 */
export function sortCandidates(tokens: ResolvedToken[]): ResolvedToken[] {
  return [...tokens].sort((a, b) => {
    const tier = MATCH_TIER_RANK[b.matchTier] - MATCH_TIER_RANK[a.matchTier];
    if (tier !== 0) return tier;
    return b.score - a.score;
  });
}

/**
 * 0..1 dominance of #1 over #2. A different (better) match tier at the top is
 * inherently confident; otherwise it's the relative score gap. Used for the
 * trade-path safety guard and confirm-UI messaging.
 */
export function computeConfidence(sorted: ResolvedToken[]): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return 1;
  const [a, b] = sorted;
  const tierGap = MATCH_TIER_RANK[a.matchTier] - MATCH_TIER_RANK[b.matchTier];
  if (tierGap > 0) return Math.max(0.85, scoreGap(a.score, b.score));
  return scoreGap(a.score, b.score);
}

function scoreGap(s1: number, s2: number): number {
  if (s1 <= 0) return 0;
  return Math.min(1, Math.max(0, (s1 - s2) / s1));
}
