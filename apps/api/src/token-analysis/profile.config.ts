/**
 * Trading profile definitions.
 * Each profile changes: scoring weights, kill thresholds, AI persona, and
 * trading strategy parameters (hold time, stop loss, targets, sizing).
 */

export type TradingProfile = 'meme_hunter' | 'degen_sniper' | 'swing_trader' | 'gem_hunt' | 'alpha_hunt';
export type ReportDepth = 'quick' | 'alpha' | 'dossier';

export interface ProfileWeights {
  safety: number;       // max 35
  distribution: number; // max 30
  market: number;       // max 20
  social: number;       // max 10
  macro: number;        // max 5
}

export interface ProfileKillOverrides {
  minLiquidityUsd?: number;
  minAgeHours?: number;
  maxAgeHours?: number;
  maxBundledSupplyPct?: number;
  maxRugScore?: number;
}

export interface ProfileStrategyDefaults {
  holdRange: string;
  stopLossPct: number;        // % below entry
  targets: number[];          // multipliers e.g. [1.5, 2, 3] = +50/+100/+200%
  positionPctRange: [number, number];  // [min%, max%] of portfolio
  trailingStopAfterT1Pct: number;     // trailing stop % after T1 hit
  maxHoldMs: number;          // milliseconds — used for countdown in UI
}

export interface ProfileDefinition {
  key: TradingProfile;
  label: string;
  tagline: string;
  color: string;              // accent color for profile-specific UI tint
  weights: ProfileWeights;
  killOverrides: ProfileKillOverrides;
  strategy: ProfileStrategyDefaults;
  aiPersona: string;          // injected into AI system prompt
}

export const PROFILES: Record<TradingProfile, ProfileDefinition> = {
  meme_hunter: {
    key: 'meme_hunter',
    label: 'Meme Hunter',
    tagline: 'Fresh launches · pump.fun · 2–10x in hours',
    color: '#f59e0b',
    weights: { safety: 25, distribution: 32, market: 25, social: 13, macro: 5 },
    killOverrides: { minLiquidityUsd: 8_000, maxBundledSupplyPct: 25, maxRugScore: 75, maxAgeHours: parseFloat(process.env.HOT_TOKEN_MAX_AGE_HOURS ?? '4') },
    strategy: {
      holdRange: '30min – 4hr',
      stopLossPct: 20,
      targets: [1.5, 2.5, 5.0],   // T1 +50%, T2 +150%, T3 +400%
      positionPctRange: [0.5, 1.5],
      trailingStopAfterT1Pct: 15,
      maxHoldMs: 4 * 60 * 60 * 1000,
    },
    aiPersona: `You are a memecoin hunter running lean, fast, and aggressive. You live for pump.fun launches,
bundle-free charts, and that moment when volume goes vertical. You know most memes die — your edge is reading
launch forensics faster than anyone else. You exit before the crowd panics, not after. Your stop losses are tight
and you never marry a position. SCORING: weight bundle detection above all — a bundled launch is an insider extraction
device, not an opportunity. Weight volume velocity and buy pressure heavily. Community traction (TG size, Twitter
activity) matters more here than for other profiles.`,
  },

  degen_sniper: {
    key: 'degen_sniper',
    label: 'Degen Sniper',
    tagline: 'Bonding curve · ultra-early · sub-30min holds',
    color: '#ef4444',
    weights: { safety: 18, distribution: 28, market: 32, social: 12, macro: 10 },
    killOverrides: { minLiquidityUsd: 3_000, maxBundledSupplyPct: 15, maxRugScore: 65, maxAgeHours: parseFloat(process.env.HOT_TOKEN_MAX_AGE_HOURS ?? '4') },
    strategy: {
      holdRange: '5min – 30min',
      stopLossPct: 25,
      targets: [2.0, 5.0, 20.0],  // T1 +100%, T2 +400%, T3 +1900%
      positionPctRange: [0.2, 0.6],
      trailingStopAfterT1Pct: 20,
      maxHoldMs: 30 * 60 * 1000,
    },
    aiPersona: `You are a bonding curve sniper — you get in before graduation and out before most people know the
token exists. You are comfortable with extreme risk for extreme reward. Your inputs are: first-buyer wallets,
dev activity in first 60 seconds, bonding curve velocity, and whether the deployer is a known bundler.
SCORING: velocity is everything. A token on the bonding curve at 40% with no bundles and a fast fill rate
is your dream setup. Ignore long-term fundamentals. Liquidity can be thin — you're sizing small.
Focus on lifecycle stage, bonding curve %, and whether deployer wallet has a track record.`,
  },

  swing_trader: {
    key: 'swing_trader',
    label: 'Swing Trader',
    tagline: 'Technical setups · days–weeks · risk-managed',
    color: '#3b82f6',
    weights: { safety: 30, distribution: 22, market: 32, social: 11, macro: 5 },
    killOverrides: { minLiquidityUsd: 50_000, minAgeHours: 6, maxRugScore: 60 },
    strategy: {
      holdRange: '2 – 14 days',
      stopLossPct: 12,
      targets: [1.25, 1.5, 2.5],   // T1 +25%, T2 +50%, T3 +150%
      positionPctRange: [1.0, 3.0],
      trailingStopAfterT1Pct: 10,
      maxHoldMs: 14 * 24 * 60 * 60 * 1000,
    },
    aiPersona: `You are a technical swing trader. You care about market structure: higher-highs/higher-lows,
volume confirmation, key price levels, and trend continuation. You need sufficient liquidity to size in without
moving the market. You look for setups where risk/reward is at minimum 2:1. SCORING: market quality is your
primary lens — volume consistency vs price action, bid depth, price impact at your trade size, organic buying
vs wash trading. Safety is table stakes. Social signals matter only as confirmation of narrative strength.
Cite specific price levels, support/resistance, and whether price action is trending or ranging.`,
  },

  gem_hunt: {
    key: 'gem_hunt',
    label: 'Gem Hunt',
    tagline: 'Fundamentals · TVL · weeks–months holds',
    color: '#22c55e',
    weights: { safety: 38, distribution: 22, market: 18, social: 12, macro: 10 },
    killOverrides: { minLiquidityUsd: 100_000, minAgeHours: 72, maxBundledSupplyPct: 10, maxRugScore: 40 },
    strategy: {
      holdRange: '2 – 12 weeks',
      stopLossPct: 20,
      targets: [2.0, 4.0, 10.0],   // T1 +100%, T2 +300%, T3 +900%
      positionPctRange: [2.0, 6.0],
      trailingStopAfterT1Pct: 15,
      maxHoldMs: 84 * 24 * 60 * 60 * 1000,
    },
    aiPersona: `You are hunting the next 10x gem — something with real fundamentals, solid tokenomics, and a
community that will hold through volatility. You care deeply about: protocol revenue/TVL trend, team
transparency, unlock schedules, and whether the smart money that is in has conviction (holding weeks,
not scalping). SCORING: safety and distribution are paramount — any rug vector is a deal-breaker because
you're planning to hold. Macro context (chain TVL trending up) is a real factor.
Smart money holding for >7 days is a strong signal. Social depth (engaged community, not just member count) matters.`,
  },

  alpha_hunt: {
    key: 'alpha_hunt',
    label: 'Alpha Hunt',
    tagline: 'Smart money overlay · any token · copy intel',
    color: '#a855f7',
    weights: { safety: 22, distribution: 18, market: 18, social: 12, macro: 5 },
    killOverrides: { minLiquidityUsd: 20_000, maxRugScore: 70 },
    strategy: {
      holdRange: 'Mirrors smart money',
      stopLossPct: 18,
      targets: [1.5, 3.0, 6.0],    // T1 +50%, T2 +200%, T3 +500%
      positionPctRange: [1.0, 2.5],
      trailingStopAfterT1Pct: 15,
      maxHoldMs: 7 * 24 * 60 * 60 * 1000,
    },
    aiPersona: `Your edge is smart money intelligence. You follow the wallets that consistently win —
wallets with 65%+ win rates, tracked by GMGN and labeled by Arkham. If elite wallets are buying, you
want to know: is this fresh entry or an exit? How large is their position relative to their history?
SCORING: smart money presence is worth 30+ points alone. A single high-conviction wallet buy from a
known winner is more signal than any technical indicator. Safety still matters — you won't follow smart
money into a honeypot. But you are willing to accept higher risk when wallet intel is strong.
Cite wallet addresses, win rates, and position sizes explicitly in your analysis.`,
  },
};

export const DEFAULT_PROFILE: TradingProfile = 'meme_hunter';

export function getProfile(key?: string | null): ProfileDefinition {
  return PROFILES[(key as TradingProfile) ?? DEFAULT_PROFILE] ?? PROFILES.meme_hunter;
}
