/**
 * Contract between API and web for the token-analysis endpoint.
 */

export type Chain = 'SOLANA' | 'EVM';

// Re-export profile types so the web layer can import from one place
export type { TradingProfile, ReportDepth } from './profile.config';
export type { TradingStrategy } from './trading-strategy.engine';
export type { ComparableToken } from './comparable-tokens.service';

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
  delta?: number;
}

export interface PlaybookBreakdown {
  baseline: number;
  appliedDeltas: { label: string; delta: number; weight: PlaybookSignal['weight'] }[];
  raw: number;
  clamped: number;
  evidenceTotal: number;
  evidenceThreshold: number;
}

export interface Playbook {
  key: PlaybookKey;
  label: string;
  description: string;
  score: number | null;
  verdict: Verdict;
  signals: PlaybookSignal[];
  breakdown: PlaybookBreakdown;
  plan?: {
    sizeHint: string;
    entry: string;
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

// ── New enriched data structures ─────────────────────────────────────────────

/** Detailed bundle-launch forensics. */
export interface BundleInfo {
  detected: boolean;
  bundleCount?: number;          // number of distinct bundle groups
  bundledSupplyPct?: number;     // % of total supply grabbed in bundles at launch
  bundledWallets?: string[];     // addresses of bundled wallets (up to 10)
  source?: string;               // which provider detected this
}

/** Price impact of a swap at different trade sizes. */
export interface PriceImpact {
  buy500Usd?: number;    // % price impact for $500 buy
  buy1000Usd?: number;
  buy5000Usd?: number;
  sell500Usd?: number;
  sell1000Usd?: number;
  sell5000Usd?: number;
}

/** Token lifecycle stage (pump.fun / other launch pad). */
export interface LifecycleInfo {
  stage: 'bonding' | 'graduated' | 'migrated' | 'mature' | 'unknown';
  bondingCurvePct?: number;      // 0-100, how far along the bonding curve
  launchPlatform?: 'pump.fun' | 'pumpswap' | 'raydium' | 'uniswap' | 'other' | 'unknown';
  graduatedAt?: string;          // ISO timestamp if graduated
  kingOfTheHill?: boolean;
}

/** Macro chain-level context. */
export interface ChainContext {
  tvlUsd?: number;
  tvl7dChangePct?: number;
  tvl30dChangePct?: number;
}

/** A single smart-money wallet signal. */
export interface SmartMoneySignal {
  walletAddress: string;
  label?: string;                // human label e.g. "0xHumbl..." or entity name
  winRate?: number;              // 0-100 if available from GMGN
  action?: 'holding' | 'bought' | 'sold';
  amountUsd?: number;
  source?: string;               // "gmgn" | "arkham"
}

// ── Holder Metrics (extended) ─────────────────────────────────────────────────

export interface HolderMetrics {
  totalHolders?: number;
  top10ConcentrationPct?: number;
  top100ConcentrationPct?: number;    // NEW — from Solana Tracker
  deployerHoldsPct?: number;
  bundleDetected?: boolean;
  bundleInfo?: BundleInfo;            // NEW — detailed bundle data
  priceImpact?: PriceImpact;          // NEW — exit sizing from Birdeye/Jupiter
  lifecycle?: LifecycleInfo;          // NEW — pump.fun lifecycle stage
  chainContext?: ChainContext;         // NEW — DeFiLlama TVL
  organicScore?: number;              // NEW — Jupiter organic score 0-100
}

// ── Social Data (extended) ────────────────────────────────────────────────────

export interface SocialData {
  twitterUrl?: string;
  telegramUrl?: string;
  websiteUrl?: string;
  telegramMembers?: number;
  telegramActiveRate?: number;        // NEW — msgs/hr estimate
  twitterMentions24h?: number;        // NEW — from snscrape
  domainAgeDays?: number;
  websiteChanged?: boolean;           // NEW — Wayback Machine detected changes
  hasSocials: boolean;
}

// ── Smart Money Result (extended) ────────────────────────────────────────────

export interface SmartMoneyResult {
  walletsChecked: number;
  holdersFound: number;
  holders: Array<{ label: string; address?: string; winRate?: number }>;
  signals?: SmartMoneySignal[];       // NEW — detailed per-wallet signals
}

// ── AI ────────────────────────────────────────────────────────────────────────

export type AiVerdict = 'STRONG_BUY' | 'BUY' | 'CAUTIOUS' | 'SKIP' | 'HIGH_RISK';

export interface AiReasoning {
  score: number;                // 0-100
  verdict: AiVerdict;
  categoryScores: {
    safety: number;             // 0-35
    distribution: number;       // 0-30  (was "holders")
    market: number;             // 0-20
    social: number;             // 0-10
    macro: number;              // 0-5
  };
  categoryReasons?: {
    safety?: string;
    distribution?: string;
    market?: string;
    social?: string;
    macro?: string;
  };
  contradictions?: string[];    // NEW — cross-signal conflicts flagged
  exitSizing?: string;          // NEW — natural language exit guidance
  bullishSignals: string[];
  riskFactors: string[];
  summary: string;
  lore?: string;                // NEW — meme/narrative origin story (2-3 sentences)
  isMeme?: boolean;             // NEW — flagged when token reads as a meme/cult coin
  generatedAt: string;
}

// ── Full Report ───────────────────────────────────────────────────────────────

export interface TokenAnalysisReport {
  meta: TokenMeta;
  safety: SafetySignals;
  playbooks: Playbook[];
  generatedAt: string;
  cacheTtlSec: number;
  providers: ProviderStatus[];
  dataSources: string[];        // legacy compat
  disclaimer: string;
  // ── Intelligence layers ──────────────────────────────────────────────────
  kill?: KillResult;
  holderMetrics?: HolderMetrics;
  socialData?: SocialData;
  smartMoney?: SmartMoneyResult;
  aiReasoning?: AiReasoning;
  // ── Profile & strategy layers ────────────────────────────────────────────
  profile?: string;             // TradingProfile key used for this report
  depth?: string;               // ReportDepth key used for this report
  tradingStrategy?: import('./trading-strategy.engine').TradingStrategy;
  comparableTokens?: import('./comparable-tokens.service').ComparableToken[];
}
