/**
 * Pure heuristic scoring for hot tokens. Kept as a free function (no NestJS
 * deps) so unit tests can target it directly without spinning up a module.
 *
 * Three-stage funnel:
 *   1. Price-action + vol/liq + age (the original Phase-0 signal set)
 *   2. Tape quality from DexScreener buys/sells/vol (Phase 1)
 *   3. Pump.fun bonding curve + community + dead-bag (Phase 2)
 *
 * Dampeners multiply positive contribution only, so a bullish-looking token
 * with thin tape / wash signature / post-ATH retrace gets crushed back to
 * realism while genuine sell pressure still drags the floor.
 */

import type { HotTokenSource, HotTokenVerdict } from './hot-tokens.types';
import type { TradingProfile } from '../token-analysis/profile.config';

export interface ScoringInput {
  priceChange1h: number;
  priceChange5m: number;
  priceChange24h: number;
  volume24hUsd: number;
  liquidityUsd: number;
  marketCapUsd: number;
  pairAgeHours: number;
  source: HotTokenSource;
  // Phase 1 tape signals (DexScreener)
  buys1h?: number;
  sells1h?: number;
  volume1hUsd?: number;
  // Phase 2 pump.fun signals — undefined for non-pump or pre-fetch
  bondingCurvePct?: number;
  graduated?: boolean;
  isLive?: boolean;
  replyCount?: number;
  athMarketCapUsd?: number;
  // Phase 3 Twitter mention signals — undefined unless TwitterMentionsService
  // was called for this candidate (top-N gating in the scanner).
  twitterAlignedMatches?: number;
  twitterUniqueAuthors?: number;
  twitterCallerFollowerLog?: number;
  twitterProjectActive?: boolean;
}

export interface ScoringResult {
  score: number;
  verdict: HotTokenVerdict;
  summary: string;
}

export function computeHotTokenScore(d: ScoringInput, profileKey: TradingProfile): ScoringResult {
  const BASE = 35;
  let posDelta = 0;
  let negDelta = 0;
  const pos: string[] = [];
  const neg: string[] = [];
  const add = (n: number, tag?: string) => { posDelta += n; if (tag) pos.push(tag); };
  const sub = (n: number, tag?: string) => { negDelta -= n; if (tag) neg.push(tag); };

  const {
    priceChange1h, priceChange5m, volume24hUsd, liquidityUsd,
    marketCapUsd, pairAgeHours, source, buys1h, sells1h, volume1hUsd,
    bondingCurvePct, graduated, isLive, replyCount, athMarketCapUsd,
    twitterAlignedMatches, twitterUniqueAuthors, twitterCallerFollowerLog,
    twitterProjectActive,
  } = d;
  const volLiq = liquidityUsd > 0 ? volume24hUsd / liquidityUsd : 0;

  // ── Phase 0: price-action ───────────────────────────────────────────────
  if (priceChange1h > 100) add(22, `+${priceChange1h.toFixed(0)}% 1h`);
  else if (priceChange1h > 50) add(15, `+${priceChange1h.toFixed(0)}% 1h`);
  else if (priceChange1h > 20) add(9, `+${priceChange1h.toFixed(0)}% 1h`);
  else if (priceChange1h > 5) add(3);
  else if (priceChange1h < -30) sub(12, `${priceChange1h.toFixed(0)}% 1h`);
  else if (priceChange1h < -15) sub(6);

  if (priceChange5m > 15) add(10, `+${priceChange5m.toFixed(0)}% 5m`);
  else if (priceChange5m > 5) add(5);
  else if (priceChange5m < -10) sub(5);

  if (volLiq > 20) add(14, `${volLiq.toFixed(0)}x vol/liq`);
  else if (volLiq > 8) add(8, `${volLiq.toFixed(0)}x vol/liq`);
  else if (volLiq > 3) add(4);
  else if (volLiq < 0.5 && liquidityUsd > 0) sub(5);

  if (liquidityUsd >= 200_000) add(7);
  else if (liquidityUsd >= 50_000) add(3);
  else if (0 < liquidityUsd && liquidityUsd < 5_000) sub(8, 'thin liq');

  // ── Profile-specific age weighting ──────────────────────────────────────
  if (profileKey === 'meme_hunter' || profileKey === 'degen_sniper') {
    if (pairAgeHours < 1) add(14, `${(pairAgeHours * 60).toFixed(0)}m old`);
    else if (pairAgeHours < 4) add(9, `${pairAgeHours.toFixed(1)}h old`);
    else if (pairAgeHours < 12) add(4, `${pairAgeHours.toFixed(0)}h old`);
    else if (pairAgeHours > 72) sub(8);
    if (source === 'pumpfun') add(5);
  } else if (profileKey === 'swing_trader') {
    if (pairAgeHours >= 6 && pairAgeHours <= 168) add(5);
    else if (pairAgeHours < 6) sub(5, 'too new');
  } else if (profileKey === 'gem_hunt') {
    if (pairAgeHours >= 72) add(10);
    else sub(12, 'too new');
  }

  // ── Phase 1: tape quality from DexScreener ──────────────────────────────
  const txCount = (buys1h ?? 0) + (sells1h ?? 0);
  const hasTape = buys1h != null && sells1h != null && txCount > 0;
  const avgTradeUsd = hasTape && volume1hUsd ? volume1hUsd / txCount : 0;
  const buyRatio = hasTape ? (buys1h as number) / txCount : 0;

  if (hasTape) {
    if (buyRatio > 0.65) add(7, `${(buyRatio * 100).toFixed(0)}% buys`);
    else if (buyRatio > 0.55) add(3);
    else if (buyRatio < 0.40) sub(8, `${(buyRatio * 100).toFixed(0)}% buys`);
    else if (buyRatio < 0.45) sub(3);
  }

  if (hasTape && marketCapUsd >= 200_000 && avgTradeUsd > 0) {
    if (avgTradeUsd > 500) add(6, `$${avgTradeUsd.toFixed(0)} avg`);
    else if (avgTradeUsd > 150) add(3);
    else if (avgTradeUsd < 15) sub(10, 'pure dust');
    else if (avgTradeUsd < 40) sub(5, 'dust trades');
  }

  if (hasTape) {
    if (txCount > 200) add(4, 'active');
    else if (txCount > 80) add(2);
    else if (pairAgeHours > 1 && txCount < 8) sub(10, 'dead tape');
  }

  if (volume1hUsd != null && marketCapUsd > 0) {
    const volMc1h = volume1hUsd / marketCapUsd;
    if (volMc1h > 0.05) add(3);
    if (volMc1h > 0.20) add(2, 'hot tape');
    if (volMc1h > 3.0)  sub(4, 'fomo peak');
    if (marketCapUsd > 500_000 && volMc1h < 0.002) sub(6, 'illiquid for size');
  }

  // ── Phase 2: pump.fun bonding curve + community ─────────────────────────
  // Pre-graduation curve progress is a "where is this token in its lifecycle"
  // signal. Pros only screen tokens past 30%; sub-30% are usually dead launches.
  if (bondingCurvePct != null && !graduated) {
    if (bondingCurvePct < 30) sub(10, 'dead curve');
    else if (bondingCurvePct < 70) add(5, `curve ${bondingCurvePct.toFixed(0)}%`);
    else if (bondingCurvePct < 95) add(8, `curve ${bondingCurvePct.toFixed(0)}%`);
  } else if (graduated) {
    add(3, 'graduated');
  }

  // Reply count — community heat proxy. Pump.fun is the only place we get
  // this; not available from any DEX feed.
  if (replyCount != null) {
    if (replyCount > 500) add(8, `🔥 ${replyCount} replies`);
    else if (replyCount > 100) add(5, `${replyCount} replies`);
    else if (replyCount > 30) add(3);
  }

  // Live stream — creator is actively present, which historically correlates
  // with short-term attention spikes on pump.fun.
  if (isLive) add(5, 'creator LIVE');

  // ── Phase 3: Twitter / X mention pressure (relevance-filtered) ──────────
  // Counts only "project-aligned" tweets (passes the relevance scorer in
  // social/twitter-relevance.ts) — so price-action shill like "$PROG 50x ape"
  // doesn't inflate the score for an unrelated token, and we don't reward
  // wash-shill clusters that all share zero narrative vocabulary.
  if (twitterAlignedMatches != null) {
    if (twitterAlignedMatches >= 50)      add(10, `🐦 ${twitterAlignedMatches}+ posts`);
    else if (twitterAlignedMatches >= 20) add(6, `🐦 ${twitterAlignedMatches} posts`);
    else if (twitterAlignedMatches >= 8)  add(3);
  }

  // Caller quality — sum of log10(followers) across unique aligned authors.
  // Damps bot-farms (many 0-follower accounts contribute ~0 each) while
  // rewarding genuine reach (a 100k-follower KOL alone contributes +5).
  if (twitterCallerFollowerLog != null) {
    if (twitterCallerFollowerLog >= 25)      add(6, 'KOL backed');
    else if (twitterCallerFollowerLog >= 12) add(3);
  }

  // Diverse author base = organic interest, not coordinated shill cluster.
  // Each unique aligned author at >=8 already passed the per-account filter;
  // diversity here is a bonus on top of raw count.
  if (twitterUniqueAuthors != null && twitterUniqueAuthors >= 15) {
    add(3, `${twitterUniqueAuthors} unique authors`);
  }

  // Project handle tweeted in last 24h — keeps the community lights on.
  if (twitterProjectActive) add(3, 'team active');

  // ── Dampeners — multipliers on positive delta only ──────────────────────
  let dampener = 1;

  // Thin-tape: big MC + dust prints + few transactions = price won't move.
  if (
    hasTape && volume1hUsd != null && marketCapUsd >= 1_000_000 &&
    avgTradeUsd > 0 && avgTradeUsd < 50 && txCount < 30
  ) {
    dampener = Math.min(dampener, 0.3);
    neg.push('paper tape');
  } else if (
    hasTape && volume1hUsd != null && marketCapUsd >= 500_000 &&
    avgTradeUsd > 0 && avgTradeUsd < 80 && txCount < 50
  ) {
    dampener = Math.min(dampener, 0.5);
    neg.push('thin tape');
  }

  // Wash-trade: huge 24h volume relative to MC but almost no live tx.
  if (
    hasTape && marketCapUsd > 0 &&
    volume24hUsd / marketCapUsd > 1.0 && txCount < 20
  ) {
    dampener = Math.min(dampener, 0.7);
    neg.push('maybe wash');
  }

  // Dead-bag: aged-out token now sitting at <30% of its ATH market cap.
  // It already had its run; statistically unlikely to repump from here.
  if (
    athMarketCapUsd != null && athMarketCapUsd > 0 && marketCapUsd > 0 &&
    pairAgeHours > 4 && marketCapUsd < athMarketCapUsd * 0.3
  ) {
    dampener = Math.min(dampener, 0.7);
    neg.push('post-ATH');
  }

  const adjustedPos = posDelta * dampener;
  const raw = BASE + adjustedPos + negDelta;
  const final = Math.max(0, Math.min(100, raw));

  let verdict: HotTokenVerdict;
  if (final >= 78) verdict = 'STRONG_BUY';
  else if (final >= 62) verdict = 'BUY';
  else if (final >= 46) verdict = 'CAUTIOUS';
  else if (final >= 28) verdict = 'SKIP';
  else verdict = 'HIGH_RISK';

  const summary = [...pos.slice(0, 2), ...neg.slice(0, 1)].join(' · ') || 'on watch';
  return { score: final, verdict, summary };
}
