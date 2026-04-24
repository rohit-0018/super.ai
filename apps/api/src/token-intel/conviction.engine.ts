import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface ConvictionInputs {
  securityScore?: number | null;       // 0..100
  holderQuality?: number | null;       // 0..100
  liquidityScore?: number | null;      // 0..100
  sentimentScore?: number | null;      // -1..1
  momentumScore?: number | null;       // -1..1
  riskFlags?: string[];
}

export interface ConvictionWeightVector {
  security: number;
  holders: number;
  liquidity: number;
  sentiment: number;
  momentum: number;
}

export interface ConvictionBreakdown {
  security: number;
  holders: number;
  liquidity: number;
  sentiment: number;
  momentum: number;
  convictionTotal: number;   // 1..10 (risk-flag capped)
  weightsUsed: ConvictionWeightVector;
  weightsVersion: number;    // 0 = defaults
  capturedAt: string;
}

export const DEFAULT_CONVICTION_WEIGHTS: ConvictionWeightVector = {
  security: 0.30,
  holders: 0.20,
  liquidity: 0.15,
  sentiment: 0.20,
  momentum: 0.15,
};

interface CacheEntry {
  weights: ConvictionWeightVector;
  version: number;
  ts: number;
}

const WEIGHT_CACHE_TTL_MS = 60_000;

/**
 * Multi-signal aggregation → 1..10 conviction score. L5 adds per-user
 * weight personalization via `scoreForUser(userId, inputs)`; legacy callers
 * use `score()` which keeps the static defaults.
 */
@Injectable()
export class ConvictionEngine {
  private readonly logger = new Logger(ConvictionEngine.name);
  private cache = new Map<string, CacheEntry>();

  constructor(private prisma: PrismaService) {}

  /** Legacy scalar entrypoint — defaults weights, returns just the total. */
  score(inp: ConvictionInputs): number {
    return ConvictionEngine.scoreWithDefaults(inp).convictionTotal;
  }

  /** Pure static function: defaults. Safe from any context. */
  static scoreWithDefaults(inp: ConvictionInputs): ConvictionBreakdown {
    return computeBreakdown(inp, DEFAULT_CONVICTION_WEIGHTS, 0);
  }

  /** Per-user entrypoint. Falls back to defaults when personalization is off. */
  async scoreForUser(userId: string, inp: ConvictionInputs): Promise<ConvictionBreakdown> {
    if (process.env.CONVICTION_PERSONALIZATION_ENABLED !== 'true') {
      return ConvictionEngine.scoreWithDefaults(inp);
    }
    const { weights, version } = await this.loadWeights(userId);
    return computeBreakdown(inp, weights, version);
  }

  async loadWeights(userId: string): Promise<{ weights: ConvictionWeightVector; version: number }> {
    const cached = this.cache.get(userId);
    if (cached && Date.now() - cached.ts < WEIGHT_CACHE_TTL_MS) {
      return { weights: cached.weights, version: cached.version };
    }
    try {
      const row = await this.prisma.userConvictionWeights.findUnique({ where: { userId } });
      const weights: ConvictionWeightVector = row
        ? { security: row.security, holders: row.holders, liquidity: row.liquidity, sentiment: row.sentiment, momentum: row.momentum }
        : DEFAULT_CONVICTION_WEIGHTS;
      const version = row?.version ?? 0;
      this.cache.set(userId, { weights, version, ts: Date.now() });
      return { weights, version };
    } catch (e: any) {
      this.logger.warn(`loadWeights user=${userId} failed: ${e.message}`);
      return { weights: DEFAULT_CONVICTION_WEIGHTS, version: 0 };
    }
  }

  invalidate(userId: string) {
    this.cache.delete(userId);
  }

  portfolioFit(tokenCategory: string, existingCategories: string[]): { fitScore: number; reason: string } {
    const count = existingCategories.filter((c) => c === tokenCategory).length;
    const total = existingCategories.length || 1;
    const concentration = count / total;
    if (concentration >= 0.5) return { fitScore: 3, reason: `Already ${Math.round(concentration * 100)}% in ${tokenCategory} — high concentration risk` };
    if (concentration >= 0.3) return { fitScore: 6, reason: `${Math.round(concentration * 100)}% in ${tokenCategory} — moderate overlap` };
    if (count === 0) return { fitScore: 9, reason: `Diversifies into ${tokenCategory} — no existing exposure` };
    return { fitScore: 7, reason: `Small existing ${tokenCategory} allocation — reasonable fit` };
  }
}

// Factor values are normalised to [0, 1]; the breakdown captures each
// factor contribution in that space so the learner can later correlate
// with win/loss labels.
function computeBreakdown(inp: ConvictionInputs, w: ConvictionWeightVector, version: number): ConvictionBreakdown {
  const sec = (inp.securityScore ?? 50) / 100;
  const hold = (inp.holderQuality ?? 50) / 100;
  const liq = (inp.liquidityScore ?? 50) / 100;
  const sent = ((inp.sentimentScore ?? 0) + 1) / 2;
  const mom = ((inp.momentumScore ?? 0) + 1) / 2;
  const blended = sec * w.security + hold * w.holders + liq * w.liquidity + sent * w.sentiment + mom * w.momentum;
  let total = 1 + blended * 9;
  if (inp.riskFlags?.length) {
    total = Math.min(total, inp.riskFlags.includes('HONEYPOT') ? 1 : 4);
  }
  total = Math.round(total * 10) / 10;
  return {
    security: sec,
    holders: hold,
    liquidity: liq,
    sentiment: sent,
    momentum: mom,
    convictionTotal: total,
    weightsUsed: { ...w },
    weightsVersion: version,
    capturedAt: new Date().toISOString(),
  };
}
