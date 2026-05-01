/**
 * Contract between API and web for the token-analysis endpoint.
 */

export type Chain = 'SOLANA' | 'EVM';

export interface TokenMeta {
  chain: Chain;
  chainId?: string;             // DexScreener-style id: "ethereum" | "bsc" | "base" | "solana" | …
  address: string;
  symbol?: string;
  name?: string;
  priceUsd?: number;
  marketCapUsd?: number;
  fdvUsd?: number;
  liquidityUsd?: number;
  volume24hUsd?: number;
  priceChange: {
    m5?: number;
    h1?: number;
    h6?: number;
    h24?: number;
  };
  txns24h?: { buys?: number; sells?: number };
  pairCreatedAt?: string;       // ISO
  pairAgeHours?: number;
  dex?: string;                 // e.g. "raydium", "uniswap-v3"
  url?: string;                 // link to chart
  socials?: Array<{ type: string; url: string }>;
  websites?: Array<{ label: string; url: string }>;
}

export interface ProviderStatus {
  name: string;
  status: 'hit' | 'miss' | 'error' | 'skipped';
  note?: string;
}

export interface SafetySignals {
  honeypot?: 'yes' | 'no' | 'unknown';
  buyTax?: number;              // bps (0-10000)
  sellTax?: number;
  transferTax?: number;
  mintAuthority?: boolean;      // solana — can mint more?
  freezeAuthority?: boolean;    // solana — can freeze?
  lpLocked?: 'yes' | 'no' | 'unknown';
  lpLockUntil?: string;
  topHoldersPct?: number;       // top 10 concentration %
  holdersCount?: number;
  deployerHoldsPct?: number;
  rugScore?: number;            // 0-100 (100 = worst)
  flags: string[];              // human-readable concern strings
}

export type Verdict = 'strong_yes' | 'yes' | 'neutral' | 'no' | 'strong_no' | 'insufficient_data';
export type PlaybookKey = 'early_safe' | 'smart_money' | 'narrative' | 'momentum';

export interface PlaybookSignal {
  label: string;
  weight: 'critical' | 'positive' | 'negative' | 'info';
  detail?: string;
  delta?: number;       // contribution to score (positive or negative). Info signals omit this.
}

export interface PlaybookBreakdown {
  baseline: number;     // always 5.0 currently
  appliedDeltas: { label: string; delta: number; weight: PlaybookSignal['weight'] }[];
  raw: number;          // baseline + sum of deltas, BEFORE clamping
  clamped: number;      // final score [0..10]
  evidenceTotal: number;// sum of |delta| — used to decide insufficient_data
  evidenceThreshold: number;
}

export interface Playbook {
  key: PlaybookKey;
  label: string;
  description: string;
  score: number | null;         // 0-10, or null if insufficient data
  verdict: Verdict;
  signals: PlaybookSignal[];
  breakdown: PlaybookBreakdown;
  plan?: {
    sizeHint: string;           // e.g. "0.5-1% of portfolio"
    entry: string;              // "market at spot" / "limit at X"
    stop: string;
    targets: string[];
    notes?: string;
  };
}

export interface KillResult {
  triggered: boolean;
  checkId?: string;
  reason?: string;
}

export interface HolderMetrics {
  totalHolders?: number;
  top10ConcentrationPct?: number;
  deployerHoldsPct?: number;
  bundleDetected?: boolean;
}

export interface SocialData {
  twitterUrl?: string;
  telegramUrl?: string;
  websiteUrl?: string;
  telegramMembers?: number;
  domainAgeDays?: number;
  hasSocials: boolean;
}

export interface SmartMoneyResult {
  walletsChecked: number;
  holdersFound: number;
  holders: Array<{ label: string }>;
}

export type AiVerdict = 'STRONG_BUY' | 'BUY' | 'CAUTIOUS' | 'SKIP' | 'HIGH_RISK';

export interface AiReasoning {
  score: number;                // 0-100
  verdict: AiVerdict;
  categoryScores: {
    safety: number;             // 0-30
    market: number;             // 0-20
    holders: number;            // 0-20
    social: number;             // 0-15
    momentum: number;           // 0-15
  };
  categoryReasons?: {
    safety?: string;            // 1-2 sentences explaining the safety score
    market?: string;            // why market got this score
    holders?: string;
    social?: string;
    momentum?: string;
  };
  bullishSignals: string[];
  riskFactors: string[];
  summary: string;
  generatedAt: string;
}

export interface TokenAnalysisReport {
  meta: TokenMeta;
  safety: SafetySignals;
  playbooks: Playbook[];
  generatedAt: string;          // ISO
  cacheTtlSec: number;
  providers: ProviderStatus[];  // per-provider hit/miss/error so UI can show why scores are thin
  dataSources: string[];        // legacy: provider names that returned data (kept for back-compat)
  disclaimer: string;
  // ── Intelligence layer (new) ────────────────────────────────────────
  kill?: KillResult;
  holderMetrics?: HolderMetrics;
  socialData?: SocialData;
  smartMoney?: SmartMoneyResult;
  aiReasoning?: AiReasoning;
}
