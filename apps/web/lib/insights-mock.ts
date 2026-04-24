/**
 * Mock insight feed for /dashboard.
 * Replace with real API data in a follow-up (trades, alerts, agent decisions,
 * whale findings, token intel, learning updates, briefings, social).
 */

export type InsightKind =
  | 'trade'
  | 'decision'
  | 'research'
  | 'whale'
  | 'token'
  | 'risk'
  | 'learning'
  | 'briefing'
  | 'social';

export type InsightCategory = 'all' | 'trades' | 'research' | 'whales' | 'tokens' | 'alerts';

export interface BaseInsight {
  id: string;
  kind: InsightKind;
  ts: string;      // ISO
  agent?: string;  // which agent, if any
  pinned?: boolean;
  token?: { symbol: string; chain: 'Solana' | 'EVM' };
}

export interface TradeInsight extends BaseInsight {
  kind: 'trade';
  side: 'buy' | 'sell';
  status: 'filled' | 'partial' | 'rejected';
  qty: string;
  price: string;
  notional: string;
  pnl?: { value: string; tone: 'up' | 'down' | 'flat' };
  reason: string;
}

export interface DecisionInsight extends BaseInsight {
  kind: 'decision';
  summary: string;
  reasoning: string[];
  evidence?: { label: string; value: string }[];
}

export interface ResearchInsight extends BaseInsight {
  kind: 'research';
  topic: string;
  summary: string;
  findings: string[];
}

export interface WhaleInsight extends BaseInsight {
  kind: 'whale';
  wallet: string;
  action: string;
  notional: string;
  cluster?: string;
}

export interface TokenInsight extends BaseInsight {
  kind: 'token';
  conviction: number;
  rugScore: number;
  holdersDelta: string;
  verdict: 'bullish' | 'neutral' | 'bearish';
  notes: string;
}

export interface RiskInsight extends BaseInsight {
  kind: 'risk';
  severity: 'low' | 'medium' | 'high';
  rule: string;
  blocked: boolean;
  note: string;
}

export interface LearningInsight extends BaseInsight {
  kind: 'learning';
  area: string;
  delta: { label: string; change: string }[];
}

export interface BriefingInsight extends BaseInsight {
  kind: 'briefing';
  window: string;
  pnl: string;
  tone: 'up' | 'down' | 'flat';
  highlights: string[];
}

export interface SocialInsight extends BaseInsight {
  kind: 'social';
  source: 'X' | 'Farcaster' | 'Telegram';
  topic: string;
  signal: string;
  mentions: string;
}

export type Insight =
  | TradeInsight
  | DecisionInsight
  | ResearchInsight
  | WhaleInsight
  | TokenInsight
  | RiskInsight
  | LearningInsight
  | BriefingInsight
  | SocialInsight;

/** Category filter: which kinds belong to which tab. */
export function matchesCategory(kind: InsightKind, cat: InsightCategory): boolean {
  if (cat === 'all') return true;
  if (cat === 'trades') return kind === 'trade' || kind === 'decision' || kind === 'briefing';
  if (cat === 'research') return kind === 'research' || kind === 'decision';
  if (cat === 'whales') return kind === 'whale';
  if (cat === 'tokens') return kind === 'token' || kind === 'social';
  if (cat === 'alerts') return kind === 'risk' || kind === 'learning';
  return true;
}

export const INSIGHTS: Insight[] = [
  {
    id: 'i-1', kind: 'briefing', ts: iso(-0.2), agent: 'Briefing · overnight',
    window: 'last 12h', pnl: '+$1,088.12', tone: 'up',
    highlights: [
      'DCA-SOL filled 50 SOL at avg $138.20 (3 partials).',
      'Blocked 1 risky token (RUG score 71/100) on EVM.',
      'Agent Copy-Trade mirrored whale 7kH… on JUP.',
    ],
  },
  {
    id: 'i-2', kind: 'trade', ts: iso(-0.5), agent: 'DCA-SOL', pinned: true,
    token: { symbol: 'SOL', chain: 'Solana' },
    side: 'buy', status: 'filled',
    qty: '50.00 SOL', price: '$138.20', notional: '$6,910',
    pnl: { value: '+$206.50 (+3.0%)', tone: 'up' },
    reason: 'Schedule tick + 4.2% dip against 24h VWAP.',
  },
  {
    id: 'i-3', kind: 'decision', ts: iso(-0.8), agent: 'Position-Monitor',
    token: { symbol: 'JUP', chain: 'Solana' },
    summary: 'Armed trailing stop at 8% for current JUP position.',
    reasoning: [
      'Position up 12.4% from entry.',
      'Vol has compressed to 1.8% (24h) — typical pre-expansion setup.',
      'User preference "protect gains on illiquids" weighs trailing > fixed.',
    ],
    evidence: [
      { label: 'Entry', value: '$0.73' },
      { label: 'Mark', value: '$0.82' },
      { label: 'Trailing', value: '8%' },
      { label: 'Stop now', value: '$0.7544' },
    ],
  },
  {
    id: 'i-4', kind: 'whale', ts: iso(-1.1),
    token: { symbol: 'SOL', chain: 'Solana' },
    wallet: '7kHx…9fWm',
    action: 'Accumulated 42,000 SOL over 3 hours across 8 wallets.',
    notional: '≈ $5.97M',
    cluster: 'smart-money · cluster #4 (71% historic win rate)',
  },
  {
    id: 'i-5', kind: 'token', ts: iso(-1.3),
    token: { symbol: 'JUP', chain: 'Solana' },
    conviction: 7.2, rugScore: 12, holdersDelta: '+4.1%', verdict: 'bullish',
    notes: 'Holders up 4.1% in 24h. LP locked 12mo. Top-10 concentration 18% (healthy). No mint authority.',
  },
  {
    id: 'i-6', kind: 'research', ts: iso(-1.6), agent: 'Research-Desk',
    topic: 'SOL breakout conditions, week-over-week',
    summary: 'Regime flipped bullish on 3 of 5 inputs; funding still neutral.',
    findings: [
      'OI up 22% week/week without a funding spike → real accumulation, not leverage.',
      'Perp premium collapsed from +0.08% to +0.01% (less crowded longs).',
      'Options skew tilted to calls (+2.4 delta) for first time in 11 days.',
    ],
  },
  {
    id: 'i-7', kind: 'risk', ts: iso(-2.0), agent: 'Guardrails',
    token: { symbol: 'PEPECOIN', chain: 'EVM' },
    severity: 'high', rule: 'GoPlus.isHoneypot', blocked: true,
    note: 'Honeypot signature detected on sell simulation. Block enforced before swap broadcast.',
  },
  {
    id: 'i-8', kind: 'trade', ts: iso(-2.2), agent: 'Copy-Trade · 7kHx…9fWm',
    token: { symbol: 'WIF', chain: 'Solana' },
    side: 'buy', status: 'partial',
    qty: '620 / 1,200 WIF', price: '$1.94', notional: '$1,203',
    reason: 'Mirroring whale swap; slippage guard paused remaining 580 @ 1.8% threshold.',
  },
  {
    id: 'i-9', kind: 'learning', ts: iso(-2.8), agent: 'Trading-DNA',
    area: 'Style profile',
    delta: [
      { label: 'SOL momentum bias', change: '+3' },
      { label: 'Meme exposure cap', change: '-1' },
      { label: 'EVM chase tolerance', change: '-2' },
    ],
  },
  {
    id: 'i-10', kind: 'social', ts: iso(-3.1),
    source: 'X', topic: 'JUP airdrop S2 speculation',
    signal: 'Mentions 12x 24h avg, sentiment +0.41 (positive shift).',
    mentions: '+1,204 in last 3h',
  },
  {
    id: 'i-11', kind: 'decision', ts: iso(-3.6), agent: 'Risk-Overseer',
    summary: 'Daily loss cap tightened to 4% (from 6%).',
    reasoning: [
      'Two consecutive red sessions (-2.1%, -1.4%).',
      'Vol regime expanded; 1-day realized vol in top decile.',
      'Style profile bias "protect capital in chop" weighted above "max opportunity".',
    ],
  },
  {
    id: 'i-12', kind: 'whale', ts: iso(-4.0),
    token: { symbol: 'ETH', chain: 'EVM' },
    wallet: '0x4C…Ba12',
    action: 'Sold 1,200 ETH to Binance hot wallet.',
    notional: '≈ $3.86M',
    cluster: 'exchange-inflow · neutral',
  },
  {
    id: 'i-13', kind: 'token', ts: iso(-4.4),
    token: { symbol: 'WIF', chain: 'Solana' },
    conviction: 5.1, rugScore: 28, holdersDelta: '-0.6%', verdict: 'neutral',
    notes: 'Momentum fading; 24h holders dipped slightly. Watch; no action recommended.',
  },
  {
    id: 'i-14', kind: 'trade', ts: iso(-5.0), agent: 'Manual · you',
    token: { symbol: 'ETH', chain: 'EVM' },
    side: 'sell', status: 'rejected',
    qty: '0.5 ETH', price: '$3,214', notional: '$1,607',
    reason: 'Rejected by guardrail: wallet gas < $5 minimum. Top up to retry.',
  },
  {
    id: 'i-15', kind: 'research', ts: iso(-6.0), agent: 'Research-Desk',
    topic: 'Meme-coin rotation map',
    summary: 'Liquidity is rotating from WIF/BONK toward newer launches.',
    findings: [
      'WIF/BONK 24h vol down 31% combined.',
      '3 new memes crossed $10M cap in 48h.',
      'Whale cluster #7 exited WIF; entered MEW + POPCAT.',
    ],
  },
  {
    id: 'i-16', kind: 'briefing', ts: iso(-7.2), agent: 'Briefing · morning',
    window: 'yesterday', pnl: '-$214.30', tone: 'down',
    highlights: [
      'Stopped out of ETH long at -1.2%; rule respected.',
      'DCA on SOL partially filled (2 of 3 slices).',
      'Learning DNA updated: bias away from EVM chops.',
    ],
  },
  {
    id: 'i-17', kind: 'whale', ts: iso(-8.0),
    token: { symbol: 'BONK', chain: 'Solana' },
    wallet: '9bQp…zz5a',
    action: 'Added 420M BONK over 40 minutes.',
    notional: '≈ $9.8K',
    cluster: 'cluster #12 (meme-early, 58% win rate)',
  },
  {
    id: 'i-18', kind: 'risk', ts: iso(-9.0), agent: 'Guardrails',
    severity: 'medium', rule: 'DailyLossCap.approaching', blocked: false,
    note: 'Approaching 75% of daily loss cap. Next loss-taking trade will be throttled to 25% size.',
  },
  {
    id: 'i-19', kind: 'social', ts: iso(-10.0),
    source: 'Farcaster', topic: 'SOL validators voting',
    signal: 'Cluster forming around bullish staking-yield narrative.',
    mentions: '+340 casts, 28 recasts',
  },
  {
    id: 'i-20', kind: 'token', ts: iso(-11.5),
    token: { symbol: 'JTO', chain: 'Solana' },
    conviction: 6.8, rugScore: 9, holdersDelta: '+2.3%', verdict: 'bullish',
    notes: 'Restaking narrative + strong fundamentals. Holders climbing steadily past 4 days.',
  },
];

function iso(hoursAgo: number): string {
  return new Date(Date.now() + hoursAgo * 3600_000).toISOString();
}

export function timeAgo(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}
