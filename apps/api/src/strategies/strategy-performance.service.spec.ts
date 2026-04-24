import { Test } from '@nestjs/testing';
import { ApprovalStatus } from '@prisma/client';
import { StrategyPerformanceService } from './strategy-performance.service';
import { PrismaService } from '../prisma/prisma.service';

describe('StrategyPerformanceService', () => {
  const mkTrade = (pnl: number | null, daysAgo = 0) => ({
    pnlUsd: pnl,
    createdAt: new Date(Date.now() - daysAgo * 86400_000),
  });

  async function build(prismaMock: Partial<PrismaService>) {
    const mod = await Test.createTestingModule({
      providers: [
        StrategyPerformanceService,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();
    return mod.get(StrategyPerformanceService);
  }

  it('computes wins, losses, pnl, and Sharpe inputs over window trades', async () => {
    const trades = [
      mkTrade(5, 2), mkTrade(5, 2), mkTrade(5, 2), mkTrade(5, 2), mkTrade(5, 2),
      mkTrade(5, 1), mkTrade(5, 1), mkTrade(5, 1), mkTrade(5, 1), mkTrade(5, 1),
      mkTrade(-3, 0), mkTrade(-3, 0), mkTrade(-3, 0), mkTrade(-3, 0), mkTrade(-3, 0),
      mkTrade(-3, 0), mkTrade(-3, 0), mkTrade(-3, 0), mkTrade(-3, 0), mkTrade(-3, 0),
    ];
    const svc = await build({
      trade: {
        findMany: jest.fn().mockResolvedValue(trades),
        aggregate: jest.fn().mockResolvedValue({ _count: { _all: 20 }, _sum: { pnlUsd: 20 } }),
      },
      approvalRequest: {
        groupBy: jest.fn().mockResolvedValue([
          { status: ApprovalStatus.APPROVED, _count: { _all: 4 } },
          { status: ApprovalStatus.REJECTED, _count: { _all: 2 } },
        ]),
      },
    } as any);

    const agg = await svc.computeFor('s1');
    expect(agg.wins).toBe(10);
    expect(agg.losses).toBe(10);
    expect(agg.totalPnlUsd).toBeCloseTo(20, 5);
    expect(agg.avgPnlUsd).toBeCloseTo(1, 5);
    expect(agg.sampleCount).toBe(20);
    expect(agg.sampleCountAllTime).toBe(20);
    expect(agg.approvalsAccepted).toBe(4);
    expect(agg.approvalsRejected).toBe(2);
    expect(agg.approvalAcceptRate).toBeCloseTo(4 / 6, 5);
    expect(agg.stdevPnlUsd).toBeGreaterThan(0);
  });

  it('returns null approvalAcceptRate when fewer than 3 decisions', async () => {
    const svc = await build({
      trade: {
        findMany: jest.fn().mockResolvedValue([]),
        aggregate: jest.fn().mockResolvedValue({ _count: { _all: 0 }, _sum: { pnlUsd: 0 } }),
      },
      approvalRequest: {
        groupBy: jest.fn().mockResolvedValue([
          { status: ApprovalStatus.APPROVED, _count: { _all: 1 } },
          { status: ApprovalStatus.REJECTED, _count: { _all: 1 } },
        ]),
      },
    } as any);

    const agg = await svc.computeFor('s1');
    expect(agg.approvalAcceptRate).toBeNull();
  });

  it('computes a non-zero max drawdown from alternating P&L', async () => {
    // Running cumulative over [+5, +3, -10, +2, -5] = [5, 8, -2, 0, -5]. Peak 8, trough -5, DD = 13.
    const trades = [mkTrade(5), mkTrade(3), mkTrade(-10), mkTrade(2), mkTrade(-5)];
    const svc = await build({
      trade: {
        findMany: jest.fn().mockResolvedValue(trades),
        aggregate: jest.fn().mockResolvedValue({ _count: { _all: 5 }, _sum: { pnlUsd: -5 } }),
      },
      approvalRequest: { groupBy: jest.fn().mockResolvedValue([]) },
    } as any);

    const agg = await svc.computeFor('s1');
    expect(agg.maxDrawdownUsd).toBeCloseTo(13, 5);
  });
});
