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

/** One contributing signal that fired during scoring. Used to render a
 *  human-readable breakdown on the detail page ("this is WHY it scored 87"). */
export interface ScoreSignal {
  /** Logical bucket the signal belongs to — drives UI grouping/coloring. */
  category:
    | 'price'
    | 'volume'
    | 'liquidity'
    | 'age'
    | 'tape'
    | 'bonding'
    | 'community'
    | 'twitter'
    | 'dampener'
    | 'dead-bag';
  /** Short human label, e.g. "+71% buys", "thin tape", "hot tape". */
  label: string;
  /** Score delta this signal contributed. Positive = bullish add, negative =
   *  penalty subtract. Dampener entries report the multiplier as e.g. -50%
   *  via the label; their delta is 0 (the multiplier is applied to posDelta). */
  delta: number;
  /** "add" / "sub" for direct deltas, "damp" for multipliers. */
  kind: 'add' | 'sub' | 'damp';
}

export interface ScoringResult {
  score: number;
  verdict: HotTokenVerdict;
  summary: string;
  /** Optional per-signal breakdown — populated when callers pass
   *  `withBreakdown: true`. Keeps the wire format light by default. */
  breakdown?: ScoreSignal[];
}

export function computeHotTokenScore(
  d: ScoringInput,
  profileKey: TradingProfile,
  opts: { withBreakdown?: boolean } = {},
): ScoringResult {
  const BASE = 35;
  let posDelta = 0;
  let negDelta = 0;
  const pos: string[] = [];
  const neg: string[] = [];
  const breakdown: ScoreSignal[] = [];
  const want = !!opts.withBreakdown;
  const add = (n: number, tag?: string, cat: ScoreSignal['category'] = 'price') => {
    posDelta += n;
    if (tag) pos.push(tag);
    if (want) breakdown.push({ category: cat, label: tag ?? '', delta: n, kind: 'add' });
  };
  const sub = (n: number, tag?: string, cat: ScoreSignal['category'] = 'price') => {
    negDelta -= n;
    if (tag) neg.push(tag);
    if (want) breakdown.push({ category: cat, label: tag ?? '', delta: -n, kind: 'sub' });
  };
  const damp = (label: string, factor: number) => {
    if (want) breakdown.push({ category: 'dampener', label, delta: 0, kind: 'damp' });
    // factor itself is logged via the label; caller applies it.
    return factor;
  };

  const {
    priceChange1h, priceChange5m, volume24hUsd, liquidityUsd,
    marketCapUsd, pairAgeHours, source, buys1h, sells1h, volume1hUsd,
    bondingCurvePct, graduated, isLive, replyCount, athMarketCapUsd,
    twitterAlignedMatches, twitterUniqueAuthors, twitterCallerFollowerLog,
    twitterProjectActive,
  } = d;
  const volLiq = liquidityUsd > 0 ? volume24hUsd / liquidityUsd : 0;

  // ── Phase 0: price-action ───────────────────────────────────────────────
  if (priceChange1h > 100) add(22, `+${priceChange1h.toFixed(0)}% 1h`, 'price');
  else if (priceChange1h > 50) add(15, `+${priceChange1h.toFixed(0)}% 1h`, 'price');
  else if (priceChange1h > 20) add(9, `+${priceChange1h.toFixed(0)}% 1h`, 'price');
  else if (priceChange1h > 5) add(3, `+${priceChange1h.toFixed(0)}% 1h`, 'price');
  else if (priceChange1h < -30) sub(12, `${priceChange1h.toFixed(0)}% 1h`, 'price');
  else if (priceChange1h < -15) sub(6, `${priceChange1h.toFixed(0)}% 1h`, 'price');

  if (priceChange5m > 15) add(10, `+${priceChange5m.toFixed(0)}% 5m`, 'price');
  else if (priceChange5m > 5) add(5, `+${priceChange5m.toFixed(0)}% 5m`, 'price');
  else if (priceChange5m < -10) sub(5, `${priceChange5m.toFixed(0)}% 5m`, 'price');

  if (volLiq > 20) add(14, `${volLiq.toFixed(0)}x vol/liq`, 'volume');
  else if (volLiq > 8) add(8, `${volLiq.toFixed(0)}x vol/liq`, 'volume');
  else if (volLiq > 3) add(4, `${volLiq.toFixed(1)}x vol/liq`, 'volume');
  else if (volLiq < 0.5 && liquidityUsd > 0) sub(5, 'low vol/liq', 'volume');

  if (liquidityUsd >= 200_000) add(7, `$${(liquidityUsd / 1000).toFixed(0)}k LP`, 'liquidity');
  else if (liquidityUsd >= 50_000) add(3, `$${(liquidityUsd / 1000).toFixed(0)}k LP`, 'liquidity');
  else if (0 < liquidityUsd && liquidityUsd < 5_000) sub(8, 'thin liq', 'liquidity');

  // ── Profile-specific age weighting ──────────────────────────────────────
  if (profileKey === 'meme_hunter' || profileKey === 'degen_sniper') {
    if (pairAgeHours < 1) add(14, `${(pairAgeHours * 60).toFixed(0)}m old`, 'age');
    else if (pairAgeHours < 4) add(9, `${pairAgeHours.toFixed(1)}h old`, 'age');
    else if (pairAgeHours < 12) add(4, `${pairAgeHours.toFixed(0)}h old`, 'age');
    else if (pairAgeHours > 72) sub(8, 'aged out', 'age');
    if (source === 'pumpfun') add(5, 'pump.fun launch', 'age');
  } else if (profileKey === 'swing_trader') {
    if (pairAgeHours >= 6 && pairAgeHours <= 168) add(5, 'mature pair', 'age');
    else if (pairAgeHours < 6) sub(5, 'too new', 'age');
  } else if (profileKey === 'gem_hunt') {
    if (pairAgeHours >= 72) add(10, '>3 day pair', 'age');
    else sub(12, 'too new', 'age');
  }

  // ── Phase 1: tape quality from DexScreener ──────────────────────────────
  const txCount = (buys1h ?? 0) + (sells1h ?? 0);
  const hasTape = buys1h != null && sells1h != null && txCount > 0;
  const avgTradeUsd = hasTape && volume1hUsd ? volume1hUsd / txCount : 0;
  const buyRatio = hasTape ? (buys1h as number) / txCount : 0;

  if (hasTape) {
    if (buyRatio > 0.65) add(7, `${(buyRatio * 100).toFixed(0)}% buys`, 'tape');
    else if (buyRatio > 0.55) add(3, `${(buyRatio * 100).toFixed(0)}% buys`, 'tape');
    else if (buyRatio < 0.40) sub(8, `${(buyRatio * 100).toFixed(0)}% buys`, 'tape');
    else if (buyRatio < 0.45) sub(3, `${(buyRatio * 100).toFixed(0)}% buys`, 'tape');
  }

  if (hasTape && marketCapUsd >= 200_000 && avgTradeUsd > 0) {
    if (avgTradeUsd > 500) add(6, `$${avgTradeUsd.toFixed(0)} avg buy`, 'tape');
    else if (avgTradeUsd > 150) add(3, `$${avgTradeUsd.toFixed(0)} avg buy`, 'tape');
    else if (avgTradeUsd < 15) sub(10, 'pure dust', 'tape');
    else if (avgTradeUsd < 40) sub(5, 'dust trades', 'tape');
  }

  if (hasTape) {
    if (txCount > 200) add(4, `${txCount} tx active`, 'tape');
    else if (txCount > 80) add(2, `${txCount} tx`, 'tape');
    else if (pairAgeHours > 1 && txCount < 8) sub(10, 'dead tape', 'tape');
  }

  if (volume1hUsd != null && marketCapUsd > 0) {
    const volMc1h = volume1hUsd / marketCapUsd;
    if (volMc1h > 0.05) add(3, `vol/MC ${(volMc1h * 100).toFixed(0)}%`, 'tape');
    if (volMc1h > 0.20) add(2, 'hot tape', 'tape');
    if (volMc1h > 3.0)  sub(4, 'fomo peak', 'tape');
    if (marketCapUsd > 500_000 && volMc1h < 0.002) sub(6, 'illiquid for size', 'tape');
  }

  // ── Phase 2: pump.fun bonding curve + community ─────────────────────────
  // Pre-graduation curve progress is a "where is this token in its lifecycle"
  // signal. Pros only screen tokens past 30%; sub-30% are usually dead launches.
  if (bondingCurvePct != null && !graduated) {
    if (bondingCurvePct < 30) sub(10, 'dead curve', 'bonding');
    else if (bondingCurvePct < 70) add(5, `curve ${bondingCurvePct.toFixed(0)}%`, 'bonding');
    else if (bondingCurvePct < 95) add(8, `curve ${bondingCurvePct.toFixed(0)}%`, 'bonding');
  } else if (graduated) {
    add(3, 'graduated', 'bonding');
  }

  if (replyCount != null) {
    if (replyCount > 500) add(8, `🔥 ${replyCount} replies`, 'community');
    else if (replyCount > 100) add(5, `${replyCount} replies`, 'community');
    else if (replyCount > 30) add(3, `${replyCount} replies`, 'community');
  }

  if (isLive) add(5, 'creator LIVE', 'community');

  // ── Phase 3: Twitter / X mention pressure (relevance-filtered) ──────────
  // Counts only "project-aligned" tweets (passes the relevance scorer in
  // social/twitter-relevance.ts) — so price-action shill like "$PROG 50x ape"
  // doesn't inflate the score for an unrelated token, and we don't reward
  // wash-shill clusters that all share zero narrative vocabulary.
  if (twitterAlignedMatches != null) {
    if (twitterAlignedMatches >= 50)      add(10, `🐦 ${twitterAlignedMatches}+ posts`, 'twitter');
    else if (twitterAlignedMatches >= 20) add(6, `🐦 ${twitterAlignedMatches} posts`, 'twitter');
    else if (twitterAlignedMatches >= 8)  add(3, `🐦 ${twitterAlignedMatches} posts`, 'twitter');
  }

  if (twitterCallerFollowerLog != null) {
    if (twitterCallerFollowerLog >= 25)      add(6, 'KOL backed', 'twitter');
    else if (twitterCallerFollowerLog >= 12) add(3, 'mid-tier callers', 'twitter');
  }

  if (twitterUniqueAuthors != null && twitterUniqueAuthors >= 15) {
    add(3, `${twitterUniqueAuthors} unique authors`, 'twitter');
  }

  if (twitterProjectActive) add(3, 'team active', 'twitter');

  // ── Dampeners — multipliers on positive delta only ──────────────────────
  let dampener = 1;

  // Thin-tape: big MC + dust prints + few transactions = price won't move.
  if (
    hasTape && volume1hUsd != null && marketCapUsd >= 1_000_000 &&
    avgTradeUsd > 0 && avgTradeUsd < 50 && txCount < 30
  ) {
    dampener = Math.min(dampener, damp('paper tape (×0.3)', 0.3));
    neg.push('paper tape');
  } else if (
    hasTape && volume1hUsd != null && marketCapUsd >= 500_000 &&
    avgTradeUsd > 0 && avgTradeUsd < 80 && txCount < 50
  ) {
    dampener = Math.min(dampener, damp('thin tape (×0.5)', 0.5));
    neg.push('thin tape');
  }

  if (
    hasTape && marketCapUsd > 0 &&
    volume24hUsd / marketCapUsd > 1.0 && txCount < 20
  ) {
    dampener = Math.min(dampener, damp('maybe wash (×0.7)', 0.7));
    neg.push('maybe wash');
  }

  if (
    athMarketCapUsd != null && athMarketCapUsd > 0 && marketCapUsd > 0 &&
    pairAgeHours > 4 && marketCapUsd < athMarketCapUsd * 0.3
  ) {
    dampener = Math.min(dampener, damp('post-ATH dead-bag (×0.7)', 0.7));
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
  return want
    ? { score: final, verdict, summary, breakdown }
    : { score: final, verdict, summary };
}
