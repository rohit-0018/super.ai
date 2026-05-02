import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { IntelSnapshotService } from './intel-snapshot.service';

/**
 * Read-side of the Intel Track Record. All endpoints are auth-gated — the
 * track record is part of the proprietary product, not a public marketing
 * page (the leaderboard is the public face). Anonymized public surface
 * lives behind a different controller if/when it ships.
 */
@UseGuards(JwtAuthGuard)
@Controller('intel-track')
export class IntelTrackController {
  constructor(
    private prisma: PrismaService,
    private snapshots: IntelSnapshotService,
  ) {}

  /**
   * GET /api/intel-track
   * Filterable list. Query params:
   *   status   — active | retired | rugged | graduated (csv allowed)
   *   source   — hot_tokens_scan | manual_scan | telegram_scan | snipe (csv)
   *   take     — 1-200, default 60
   *   sort     — pumpedHigh | recent (default recent)
   *   minDelta — minimum % gain since capture (e.g. 50 = filter to 50%+ wins)
   */
  @Get()
  async list(
    @Query('status') status?: string,
    @Query('source') source?: string,
    @Query('take') takeRaw?: string,
    @Query('sort') sort?: string,
    @Query('minDelta') minDeltaRaw?: string,
  ) {
    const take = Math.min(Math.max(parseInt(takeRaw ?? '60', 10) || 60, 1), 200);
    const where: any = {};
    if (status) {
      const arr = status.split(',').map((s) => s.trim()).filter(Boolean);
      if (arr.length) where.status = { in: arr };
    } else {
      where.status = { in: ['active', 'graduated'] };
    }
    if (source) {
      const arr = source.split(',').map((s) => s.trim()).filter(Boolean);
      if (arr.length) where.source = { in: arr };
    }

    const orderBy = sort === 'pumpedHigh'
      ? [{ pumpedHigh: 'desc' as const }]
      : [{ capturedAt: 'desc' as const }];

    const rows = await this.prisma.intelSnapshot.findMany({
      where, orderBy, take,
      select: {
        id: true, chain: true, address: true, symbol: true, name: true,
        capturedAt: true, source: true, profileKey: true,
        priceUsdAtCapture: true, marketCapUsdAtCapture: true,
        liquidityUsdAtCapture: true, volume24hAtCapture: true,
        aiScore: true, aiVerdict: true, aiSummary: true,
        killTriggered: true, lastRescannedAt: true,
        currentPriceUsd: true, currentMcapUsd: true, currentLiquidity: true,
        pumpedHigh: true, pumpedHighAt: true,
        drawdownLow: true, drawdownLowAt: true,
        rescanCount: true, reappearedAt: true, reappearedSource: true,
        status: true, sparkline: true,
      },
    });

    const minDelta = minDeltaRaw ? parseFloat(minDeltaRaw) : null;
    return rows
      .map((r) => decorate(r))
      .filter((r) => minDelta == null || (r.peakDeltaPct != null && r.peakDeltaPct >= minDelta));
  }

  /**
   * GET /api/intel-track/top
   * Top by peak delta — the marketing-grade winners list.
   */
  @Get('top')
  async top(@Query('limit') limitRaw?: string) {
    const limit = Math.min(Math.max(parseInt(limitRaw ?? '5', 10) || 5, 1), 50);
    return this.snapshots.listTop(limit);
  }

  /**
   * GET /api/intel-track/stats
   * Aggregate marketing stats for the hero strip.
   */
  @Get('stats')
  async stats() {
    const [total, graduated, retired, rugged] = await Promise.all([
      this.prisma.intelSnapshot.count(),
      this.prisma.intelSnapshot.count({ where: { status: 'graduated' } }),
      this.prisma.intelSnapshot.count({ where: { status: 'retired' } }),
      this.prisma.intelSnapshot.count({ where: { status: 'rugged' } }),
    ]);
    // Average peak delta across non-rugged calls — clamps marketing claim
    // to actual performance. Rugged excluded so a rug doesn't crater the
    // average to -100% (rugs are tracked separately as a transparency stat).
    const winners = await this.prisma.intelSnapshot.findMany({
      where: {
        status: { in: ['active', 'graduated'] },
        marketCapUsdAtCapture: { not: null, gt: 0 },
        pumpedHigh: { not: null },
      },
      select: { marketCapUsdAtCapture: true, pumpedHigh: true },
      take: 1000,
    });
    const deltas = winners
      .map((w) => {
        const base = w.marketCapUsdAtCapture as number;
        const peak = w.pumpedHigh as number;
        return base > 0 ? ((peak - base) / base) * 100 : 0;
      })
      .filter(Number.isFinite);
    const avgPeakDeltaPct = deltas.length ? deltas.reduce((s, d) => s + d, 0) / deltas.length : 0;

    const best = await this.prisma.intelSnapshot.findFirst({
      where: { status: { in: ['active', 'graduated'] } },
      orderBy: { pumpedHigh: 'desc' },
      select: {
        id: true, symbol: true, address: true, capturedAt: true,
        marketCapUsdAtCapture: true, pumpedHigh: true,
      },
    });

    return {
      totalSnapshots: total,
      graduated, retired, rugged,
      active: total - graduated - retired - rugged,
      avgPeakDeltaPct,
      bestCall: best ? {
        ...best,
        deltaPct: best.marketCapUsdAtCapture && best.pumpedHigh && best.marketCapUsdAtCapture > 0
          ? ((best.pumpedHigh - best.marketCapUsdAtCapture) / best.marketCapUsdAtCapture) * 100
          : null,
      } : null,
    };
  }

  /**
   * GET /api/intel-track/:id
   * Full detail — snapshot + recent rescan timeline (last 100 ticks).
   */
  @Get(':id')
  async detail(@Param('id') id: string) {
    const snapshot = await this.prisma.intelSnapshot.findUnique({ where: { id } });
    if (!snapshot) return null;
    const ticks = await this.prisma.intelRescan.findMany({
      where: { snapshotId: id },
      orderBy: { ts: 'desc' },
      take: 100,
    });
    return { ...decorate(snapshot as any), ticks };
  }
}

/** Decorate a raw snapshot row with derived deltas the UI needs everywhere. */
function decorate(r: any) {
  const captureMcap = r.marketCapUsdAtCapture as number | null;
  const peak = r.pumpedHigh as number | null;
  const cur = r.currentMcapUsd as number | null;
  const peakDeltaPct = captureMcap && peak && captureMcap > 0
    ? ((peak - captureMcap) / captureMcap) * 100 : null;
  const currentDeltaPct = captureMcap && cur && captureMcap > 0
    ? ((cur - captureMcap) / captureMcap) * 100 : null;
  return { ...r, peakDeltaPct, currentDeltaPct };
}
