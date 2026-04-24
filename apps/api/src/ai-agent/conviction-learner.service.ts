import { Injectable, Logger } from '@nestjs/common';
import { Prisma, TradeEpisode } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  ConvictionEngine,
  ConvictionWeightVector,
  DEFAULT_CONVICTION_WEIGHTS,
} from '../token-intel/conviction.engine';

export type LearnerTrigger = 'cron' | 'milestone' | 'manual';

export interface RecomputeResult {
  applied?: boolean;
  skipped?: string;
  before?: ConvictionWeightVector;
  after?: ConvictionWeightVector;
  sampleCount?: number;
  edge?: ConvictionWeightVector;
}

const MIN_SAMPLES = 20;
const MAX_STEP = 0.05;
const WEIGHT_CLAMP_LO = 0.05;
const WEIGHT_CLAMP_HI = 0.60;
const BACKTEST_REGRESSION_FLOOR = 0.9; // new simulated PnL must be ≥ 0.9× old

interface LabeledTrade {
  breakdown: ConvictionWeightVector & { convictionTotal: number };
  y: number; // 1 = winner, 0 = loser
  pnlUsd: number;
}

@Injectable()
export class ConvictionLearnerService {
  private readonly logger = new Logger(ConvictionLearnerService.name);

  constructor(private prisma: PrismaService, private engine: ConvictionEngine) {}

  async recomputeWeights(userId: string, trigger: LearnerTrigger): Promise<RecomputeResult> {
    if (process.env.CONVICTION_PERSONALIZATION_ENABLED !== 'true') return { skipped: 'flag_off' };

    const cfg = await this.prisma.learningConfig.findUnique({ where: { userId } });
    if (!cfg?.enabled) return { skipped: 'learning_off' };

    const current = await this.prisma.userConvictionWeights.findUnique({ where: { userId } });
    if (current?.manualOverride) return { skipped: 'manual_override' };

    const labeled = await this.loadLabeledTrades(userId);
    if (labeled.length < MIN_SAMPLES) {
      return { skipped: 'insufficient_samples', sampleCount: labeled.length };
    }

    const w = current
      ? { security: current.security, holders: current.holders, liquidity: current.liquidity, sentiment: current.sentiment, momentum: current.momentum }
      : { ...DEFAULT_CONVICTION_WEIGHTS };

    const edge = computeEdgeVector(labeled);
    const N = labeled.length;
    const eta = Math.min(MAX_STEP, 0.20 * Math.sqrt(N / 100));

    // Gradient step + clamp + renormalise + per-weight stability cap.
    const wRaw: ConvictionWeightVector = {
      security: clamp(w.security + eta * edge.security, WEIGHT_CLAMP_LO, WEIGHT_CLAMP_HI),
      holders: clamp(w.holders + eta * edge.holders, WEIGHT_CLAMP_LO, WEIGHT_CLAMP_HI),
      liquidity: clamp(w.liquidity + eta * edge.liquidity, WEIGHT_CLAMP_LO, WEIGHT_CLAMP_HI),
      sentiment: clamp(w.sentiment + eta * edge.sentiment, WEIGHT_CLAMP_LO, WEIGHT_CLAMP_HI),
      momentum: clamp(w.momentum + eta * edge.momentum, WEIGHT_CLAMP_LO, WEIGHT_CLAMP_HI),
    };
    let wNext = renormalize(wRaw);
    wNext = {
      security: clamp(wNext.security, w.security - MAX_STEP, w.security + MAX_STEP),
      holders: clamp(wNext.holders, w.holders - MAX_STEP, w.holders + MAX_STEP),
      liquidity: clamp(wNext.liquidity, w.liquidity - MAX_STEP, w.liquidity + MAX_STEP),
      sentiment: clamp(wNext.sentiment, w.sentiment - MAX_STEP, w.sentiment + MAX_STEP),
      momentum: clamp(wNext.momentum, w.momentum - MAX_STEP, w.momentum + MAX_STEP),
    };
    wNext = renormalize(wNext);

    // Backtest safety rail: only commit if simulated PnL under new weights
    // isn't catastrophically worse than the old weights.
    const { oldPnl, newPnl } = simulatePnl(labeled.slice(-50), w, wNext);
    if (newPnl < oldPnl * BACKTEST_REGRESSION_FLOOR) {
      await this.appendHistory(userId, w, (current?.version ?? 1), labeled.length, 'rejected_backtest');
      this.logger.warn(`user=${userId} conviction learner rejected: newPnl=${newPnl.toFixed(2)} vs oldPnl=${oldPnl.toFixed(2)}`);
      return { skipped: 'backtest_regression', sampleCount: labeled.length, before: w, after: wNext };
    }

    const nextVersion = (current?.version ?? 1) + 1;
    await this.prisma.userConvictionWeights.upsert({
      where: { userId },
      create: { userId, ...wNext, version: nextVersion, sampleCount: labeled.length, learnedAt: new Date() },
      update: { ...wNext, version: nextVersion, sampleCount: labeled.length, learnedAt: new Date() },
    });
    await this.appendHistory(userId, wNext, nextVersion, labeled.length, `learner:${trigger}`);
    this.engine.invalidate(userId);

    return { applied: true, before: w, after: wNext, edge, sampleCount: labeled.length };
  }

  async reset(userId: string): Promise<void> {
    const current = await this.prisma.userConvictionWeights.findUnique({ where: { userId } });
    const nextVersion = (current?.version ?? 1) + 1;
    await this.prisma.userConvictionWeights.upsert({
      where: { userId },
      create: { userId, ...DEFAULT_CONVICTION_WEIGHTS, version: nextVersion },
      update: { ...DEFAULT_CONVICTION_WEIGHTS, version: nextVersion, manualOverride: false, learnedAt: null },
    });
    await this.appendHistory(userId, DEFAULT_CONVICTION_WEIGHTS, nextVersion, 0, 'reset');
    this.engine.invalidate(userId);
  }

  private async appendHistory(userId: string, w: ConvictionWeightVector, version: number, sampleCount: number, reason: string) {
    await this.prisma.convictionWeightsHistory.create({
      data: { userId, version, ...w, sampleCount, reason },
    });
  }

  // Up to 100 most-recent trades whose convictionBreakdown is set AND have a
  // label (L2 outcome1h preferred; falls back to pnlUsd sign). Paper trades
  // without realised pnl are skipped.
  private async loadLabeledTrades(userId: string): Promise<LabeledTrade[]> {
    const trades = await this.prisma.trade.findMany({
      where: { userId, convictionBreakdown: { not: Prisma.JsonNull } },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { episode: { select: { outcome1h: true } } },
    });
    const out: LabeledTrade[] = [];
    for (const t of trades) {
      const bd = asBreakdown(t.convictionBreakdown);
      if (!bd) continue;
      const label = extractLabel(t.episode ?? null, t.pnlUsd);
      if (label == null) continue;
      out.push({ breakdown: bd, y: label.y, pnlUsd: label.pnlUsd });
      if (out.length >= 100) break;
    }
    return out;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function renormalize(w: ConvictionWeightVector): ConvictionWeightVector {
  const sum = w.security + w.holders + w.liquidity + w.sentiment + w.momentum;
  if (sum <= 0) return { ...DEFAULT_CONVICTION_WEIGHTS };
  return {
    security: w.security / sum,
    holders: w.holders / sum,
    liquidity: w.liquidity / sum,
    sentiment: w.sentiment / sum,
    momentum: w.momentum / sum,
  };
}

function computeEdgeVector(labeled: LabeledTrade[]): ConvictionWeightVector {
  const pos = labeled.filter((l) => l.y === 1);
  const neg = labeled.filter((l) => l.y === 0);
  const mean = (arr: LabeledTrade[], key: keyof ConvictionWeightVector) =>
    arr.length ? arr.reduce((s, l) => s + (l.breakdown as any)[key], 0) / arr.length : 0;
  return {
    security: clamp(mean(pos, 'security') - mean(neg, 'security'), -1, 1),
    holders: clamp(mean(pos, 'holders') - mean(neg, 'holders'), -1, 1),
    liquidity: clamp(mean(pos, 'liquidity') - mean(neg, 'liquidity'), -1, 1),
    sentiment: clamp(mean(pos, 'sentiment') - mean(neg, 'sentiment'), -1, 1),
    momentum: clamp(mean(pos, 'momentum') - mean(neg, 'momentum'), -1, 1),
  };
}

function simulatePnl(
  labeled: LabeledTrade[],
  wOld: ConvictionWeightVector,
  wNew: ConvictionWeightVector,
): { oldPnl: number; newPnl: number } {
  let oldPnl = 0;
  let newPnl = 0;
  for (const l of labeled) {
    const totalOld = 1 + blend(l.breakdown, wOld) * 9;
    const totalNew = 1 + blend(l.breakdown, wNew) * 9;
    if (totalOld >= 6) oldPnl += l.pnlUsd;
    if (totalNew >= 6) newPnl += l.pnlUsd;
  }
  // Avoid divide-by-zero — anchor both at 1 when no trades would have fired.
  if (oldPnl === 0 && newPnl === 0) return { oldPnl: 1, newPnl: 1 };
  if (oldPnl === 0) return { oldPnl: 1, newPnl: newPnl >= 0 ? 1 : BACKTEST_REGRESSION_FLOOR };
  return { oldPnl, newPnl };
}

function blend(bd: LabeledTrade['breakdown'], w: ConvictionWeightVector): number {
  return (
    bd.security * w.security +
    bd.holders * w.holders +
    bd.liquidity * w.liquidity +
    bd.sentiment * w.sentiment +
    bd.momentum * w.momentum
  );
}

function asBreakdown(raw: unknown): (ConvictionWeightVector & { convictionTotal: number }) | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const sec = n(r.security), hol = n(r.holders), liq = n(r.liquidity), sen = n(r.sentiment), mom = n(r.momentum), tot = n(r.convictionTotal);
  if (sec == null || hol == null || liq == null || sen == null || mom == null || tot == null) return null;
  return { security: sec, holders: hol, liquidity: liq, sentiment: sen, momentum: mom, convictionTotal: tot };
}

function extractLabel(episode: { outcome1h: unknown } | null, pnlUsd: number | null): { y: number; pnlUsd: number } | null {
  // Prefer L2 outcome1h if present.
  if (episode?.outcome1h && typeof episode.outcome1h === 'object') {
    const p = Number((episode.outcome1h as any).priceDeltaPct);
    if (Number.isFinite(p)) {
      const pnl = pnlUsd ?? p; // fall back to delta % as a proxy if realised pnl is null
      return { y: p >= 0 ? 1 : 0, pnlUsd: pnl };
    }
  }
  if (pnlUsd == null || pnlUsd === 0) return null;
  return { y: pnlUsd > 0 ? 1 : 0, pnlUsd };
}
