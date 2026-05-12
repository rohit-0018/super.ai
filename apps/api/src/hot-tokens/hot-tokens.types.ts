export type HotTokenSource = 'pumpfun' | 'dexscreener_boost' | 'dexscreener_profile' | 'geckoterminal_new' | 'geckoterminal_trending';
export type HotTokenVerdict = 'STRONG_BUY' | 'BUY' | 'CAUTIOUS' | 'SKIP' | 'HIGH_RISK';

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
}

export interface HotTokensScan {
  tokens: HotToken[];
  profileKey: string;
  scannedAt: string;
  nextScanAt: string;
  scanIntervalMs: number;
  fastScanEnabled: boolean;
}

export interface AllProfilesScan {
  byProfile: Record<string, HotToken[]>;
  scannedAt: string;
  nextScanAt: string;
  scanIntervalMs: number;
}

export interface HotTokensRefresh {
  tokens: Array<Pick<HotToken, 'address' | 'priceUsd' | 'priceChange1h' | 'priceChange5m' | 'volume24hUsd'>>;
  refreshedAt: string;
}
