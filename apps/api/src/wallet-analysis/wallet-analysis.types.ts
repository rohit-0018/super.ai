export type Chain = 'SOLANA' | 'EVM';

export type RiskProfile =
  | 'sniper'        // small fast meme trades, <1h holds
  | 'momentum'      // hours-to-days, trend followers
  | 'swing'         // days-to-weeks
  | 'holder'        // weeks+, low turnover
  | 'mixed'         // no dominant pattern
  | 'insufficient'; // not enough data

export interface WalletTokenExposure {
  symbol?: string;
  address: string;
  sharePct: number;   // % of wallet notional
  pnlUsd?: number;
  tradesCount?: number;
}

export interface WindowStats {
  windowDays: number;
  trades: number;
  winRate: number | null;     // 0..1
  pnlUsd: number | null;
  avgHoldHours: number | null;
  bestTradePnl?: number | null;
  worstTradePnl?: number | null;
}

export interface CopyFitVerdict {
  verdict: 'copy_with_scaling' | 'watch_only' | 'avoid' | 'insufficient_data';
  score: number; // 0-10
  reasons: string[];
  suggestedScale: number; // 0..1 — multiply whale size by this if copying
}

export interface WalletAnalysisReport {
  chain: Chain;
  address: string;
  labels: string[];       // heuristic labels: "new wallet", "high activity", "likely sniper", etc.
  firstSeen?: string;     // ISO
  lastActive?: string;
  windows: WindowStats[];
  riskProfile: RiskProfile;
  topTokens: WalletTokenExposure[];
  copyFit: CopyFitVerdict;
  dataSources: string[];
  coverageNote: string;   // plain-language honesty about how complete the data is
  generatedAt: string;
  disclaimer: string;
}
