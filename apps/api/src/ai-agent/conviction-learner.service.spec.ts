import { Test } from '@nestjs/testing';
import { ConvictionLearnerService } from './conviction-learner.service';
import { ConvictionEngine, DEFAULT_CONVICTION_WEIGHTS } from '../token-intel/conviction.engine';
import { PrismaService } from '../prisma/prisma.service';

describe('ConvictionLearnerService', () => {
  const origEnv = process.env.CONVICTION_PERSONALIZATION_ENABLED;
  beforeAll(() => { process.env.CONVICTION_PERSONALIZATION_ENABLED = 'true'; });
  afterAll(() => { process.env.CONVICTION_PERSONALIZATION_ENABLED = origEnv; });

  function mkTrade(winner: boolean, factors: { security: number; holders: number; liquidity: number; sentiment: number; momentum: number }) {
    return {
      pnlUsd: winner ? 5 : -3,
      convictionBreakdown: {
        ...factors,
        convictionTotal: 6,
      },
      episode: { outcome1h: { priceDeltaPct: winner ? 5 : -3 } },
    };
  }

  async function build(prismaMock: Partial<PrismaService>) {
    const engine = { loadWeights: jest.fn(), invalidate: jest.fn() } as unknown as ConvictionEngine;
    const mod = await Test.createTestingModule({
      providers: [
        ConvictionLearnerService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: ConvictionEngine, useValue: engine },
      ],
    }).compile();
    return { svc: mod.get(ConvictionLearnerService), engine };
  }

  it('insufficient_samples when fewer than 20 labeled trades', async () => {
    const { svc } = await build({
      learningConfig: { findUnique: jest.fn().mockResolvedValue({ enabled: true }) },
      userConvictionWeights: { findUnique: jest.fn().mockResolvedValue(null) },
      trade: { findMany: jest.fn().mockResolvedValue([]) },
    } as any);
    const out = await svc.recomputeWeights('u1', 'cron');
    expect(out.skipped).toBe('insufficient_samples');
  });

  it('lifts security weight when winners separate on security axis', async () => {
    const winners = Array.from({ length: 15 }, () => mkTrade(true, { security: 0.9, holders: 0.5, liquidity: 0.5, sentiment: 0.5, momentum: 0.5 }));
    const losers = Array.from({ length: 15 }, () => mkTrade(false, { security: 0.3, holders: 0.5, liquidity: 0.5, sentiment: 0.5, momentum: 0.5 }));
    const all = [...winners, ...losers];
    const updates: any[] = [];
    const { svc } = await build({
      learningConfig: { findUnique: jest.fn().mockResolvedValue({ enabled: true }) },
      userConvictionWeights: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn((args) => { updates.push(args); return Promise.resolve(args.create); }),
      },
      convictionWeightsHistory: { create: jest.fn().mockResolvedValue({}) },
      trade: { findMany: jest.fn().mockResolvedValue(all) },
    } as any);
    const out = await svc.recomputeWeights('u1', 'cron');
    expect(out.applied).toBe(true);
    expect(out.after!.security).toBeGreaterThan(DEFAULT_CONVICTION_WEIGHTS.security);
    // Sum must still hit ~1 after renormalise.
    const sum = out.after!.security + out.after!.holders + out.after!.liquidity + out.after!.sentiment + out.after!.momentum;
    expect(sum).toBeCloseTo(1, 3);
    // Per-weight step cap: no factor drifts more than 0.05 from the prior.
    expect(Math.abs(out.after!.security - DEFAULT_CONVICTION_WEIGHTS.security)).toBeLessThanOrEqual(0.0501);
  });

  it('honors manualOverride by skipping', async () => {
    const { svc } = await build({
      learningConfig: { findUnique: jest.fn().mockResolvedValue({ enabled: true }) },
      userConvictionWeights: { findUnique: jest.fn().mockResolvedValue({ ...DEFAULT_CONVICTION_WEIGHTS, version: 2, manualOverride: true }) },
    } as any);
    const out = await svc.recomputeWeights('u1', 'cron');
    expect(out.skipped).toBe('manual_override');
  });
});
