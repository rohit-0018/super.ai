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

export function timeAgo(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}
