export type HotTokenSource = 'pumpfun' | 'dexscreener_boost' | 'dexscreener_profile' | 'geckoterminal_new' | 'geckoterminal_trending';
export type HotTokenVerdict = 'STRONG_BUY' | 'BUY' | 'CAUTIOUS' | 'SKIP' | 'HIGH_RISK';

export type ScoreSignalCategory =
  | 'price' | 'volume' | 'liquidity' | 'age'
  | 'tape' | 'bonding' | 'community' | 'twitter'
  | 'dampener' | 'dead-bag';

export interface ScoreSignal {
  category: ScoreSignalCategory;
  label: string;
  delta: number;
  kind: 'add' | 'sub' | 'damp';
}

export interface HotToken {
  address: string;
  symbol: string;
  name: string;
  chain: 'SOLANA';
  priceUsd: number;
  priceChange5m: number;
  priceChange1h: number;
  priceChange24h: number;
  volume24hUsd: number;
  marketCapUsd: number;
  liquidityUsd: number;
  pairAgeHours: number;
  source: HotTokenSource;
  launchPlatform?: string;
  score: number;           // 0–100 heuristic (no AI cost per token)
  verdict: HotTokenVerdict;
  summary: string;         // one-line summary string
  dexUrl?: string;
  profileKey: string;
  scannedAt: string;       // ISO timestamp
  // Phase 1 tape-quality fields (DexScreener-sourced, optional fallback paths).
  buys1h?: number;
  sells1h?: number;
  volume1hUsd?: number;
  /** Per-signal scoring breakdown — populated for every scanned token. */
  scoreBreakdown?: ScoreSignal[];
}

export interface HotTokensScan {
  /** QWAI-curated picks — heuristic score >= QWAI_HOT_SCORE_MIN. These are
   *  "hot according to our scoring", not just "any token on-chain". */
  tokens: HotToken[];
  /** Raw on-chain hotness — sorted by 24h volume + source priority, NO score
   *  filter. Same enriched data as `tokens`, just a different ranking. Lets the
   *  UI show "what's pumping on Solana right now" separately from "what QWAI
   *  thinks you should look at". */
  chainTokens?: HotToken[];
  profileKey: string;
  scannedAt: string;
  nextScanAt: string;
  scanIntervalMs: number;
  fastScanEnabled: boolean;
}

export interface AllProfilesScan {
  byProfile: Record<string, HotToken[]>;
  /** Optional chain-hot view per profile (same shape as byProfile, ranked by
   *  on-chain hotness rather than QWAI score). */
  chainByProfile?: Record<string, HotToken[]>;
  scannedAt: string;
  nextScanAt: string;
  scanIntervalMs: number;
}

export interface HotTokensRefresh {
  tokens: Array<Pick<HotToken, 'address' | 'priceUsd' | 'priceChange1h' | 'priceChange5m' | 'volume24hUsd'>>;
  refreshedAt: string;
}
