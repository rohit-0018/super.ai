import { Injectable, Logger } from '@nestjs/common';
import { Chain } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { TokenAnalysisReport } from '../token-analysis/token-analysis.types';

export type IntelSource = 'hot_tokens_scan' | 'manual_scan' | 'telegram_scan' | 'snipe';
export type IntelStatus = 'active' | 'retired' | 'rugged' | 'graduated';

const MIN_AI_SCORE = parseInt(process.env.INTEL_TRACK_CAPTURE_MIN_AI_SCORE ?? '60', 10);
const SPARKLINE_MAX_POINTS = 60;

interface CaptureInput {
  chain: Chain;
  address: string;
  symbol?: string | null;
  name?: string | null;
  source: IntelSource;
  profileKey?: string | null;
  userId?: string | null;
  report: TokenAnalysisReport;
}

/**
 * IntelSnapshotService — write-side of the track record.
 *
 * Responsibilities:
 *  - capture(): idempotent freeze of a token call. If a row already exists
 *    for this (chain, address), do NOT create a duplicate — instead bump
 *    reappearedAt + reappearedSource so we can show "called this twice".
 *  - findByAddress(): fast lookup used by the Telegram formatter ("we
 *    called this 12d ago at $480K MCap, peaked at $4.2M…").
 *
 * Capture filtering: only snapshots where
 *    aiScore >= INTEL_TRACK_CAPTURE_MIN_AI_SCORE (default 60)
 *    OR killTriggered (so we have a record of the bad calls too)
 *    OR source === 'snipe' (actual money was put in — always record)
 *
 * Stays cheap: the heavy work (price re-scans, status updates, auto-purge)
 * happens in the IntelRescanWorker, NOT here.
 */
@Injectable()
export class IntelSnapshotService {
  private readonly logger = new Logger(IntelSnapshotService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Idempotent on (chain, address). Returns the snapshot id (new or existing)
   * so callers can correlate. Emits a debug log so we can see capture rate
   * in production.
   */
  async capture(input: CaptureInput): Promise<{ id: string; created: boolean } | null> {
    const { chain, address, source, report, userId, profileKey } = input;
    if (!address || !report) return null;

    const aiScore = report.aiReasoning?.score ?? null;
    const aiVerdict = report.aiReasoning?.verdict ?? null;
    const aiSummary = report.aiReasoning?.summary ?? null;
    const killTriggered = !!report.kill?.triggered;

    // Capture filter — see class doc.
    const passes =
      source === 'snipe' ||
      killTriggered ||
      (aiScore != null && aiScore >= MIN_AI_SCORE);
    if (!passes) return null;

    const meta = report.meta;
    const priceUsd = meta.priceUsd;
    if (priceUsd == null || !Number.isFinite(priceUsd) || priceUsd <= 0) {
      // Useless snapshot if we can't anchor a price — would corrupt every
      // future delta calculation.
      return null;
    }

    const normalizedAddress = chain === 'EVM' ? address.toLowerCase() : address;

    try {
      const existing = await this.prisma.intelSnapshot.findUnique({
        where: { chain_address: { chain, address: normalizedAddress } } as any,
      });

      if (existing) {
        // Re-appearance: mark the timestamp + source. Do not mutate the
        // frozen call data — that's the marketing claim. If the new source
        // is meaningful (different from the original), record it so the UI
        // can show "appeared again in <new source>".
        await this.prisma.intelSnapshot.update({
          where: { id: existing.id },
          data: {
            reappearedAt: new Date(),
            reappearedSource: source,
          },
        });
        return { id: existing.id, created: false };
      }

      const created = await this.prisma.intelSnapshot.create({
        data: {
          userId: userId ?? null,
          chain,
          address: normalizedAddress,
          symbol: input.symbol ?? meta.symbol ?? null,
          name: input.name ?? meta.name ?? null,
          source,
          profileKey: profileKey ?? null,
          priceUsdAtCapture: priceUsd,
          marketCapUsdAtCapture: meta.marketCapUsd ?? null,
          liquidityUsdAtCapture: meta.liquidityUsd ?? null,
          volume24hAtCapture: meta.volume24hUsd ?? null,
          // Strip per-snapshot heavy fields from the report — comparable
          // tokens lists and full holder rosters are huge and we already
          // have what we need on the frozen capture columns.
          reportJson: this.slimReport(report) as any,
          aiScore,
          aiVerdict,
          aiSummary,
          killTriggered,
          // Seed sparkline with the first point.
          sparkline: meta.marketCapUsd != null ? [Math.round(meta.marketCapUsd)] : [],
          // Seed current* with the capture values so first reads aren't blank.
          currentPriceUsd: priceUsd,
          currentMcapUsd: meta.marketCapUsd ?? null,
          currentLiquidity: meta.liquidityUsd ?? null,
          pumpedHigh: meta.marketCapUsd ?? null,
          pumpedHighAt: meta.marketCapUsd != null ? new Date() : null,
          drawdownLow: meta.marketCapUsd ?? null,
          drawdownLowAt: meta.marketCapUsd != null ? new Date() : null,
        },
      });

      this.logger.log(
        `captured [${source}] ${meta.symbol ?? normalizedAddress.slice(0, 8)} ` +
        `mcap=${meta.marketCapUsd ?? '?'} ai=${aiScore ?? '?'}/100 verdict=${aiVerdict ?? '-'}`,
      );
      return { id: created.id, created: true };
    } catch (e: any) {
      this.logger.warn(`capture failed for ${address}: ${e.message}`);
      return null;
    }
  }

  /**
   * Lookup by address — used by Telegram formatter to surface "we called
   * this N days ago at $X, peaked at $Y" badge on user-initiated scans.
   * Returns null if no snapshot exists.
   */
  async findByAddress(chain: Chain, address: string): Promise<{
    id: string;
    capturedAt: Date;
    mcapAtCapture: number | null;
    pumpedHigh: number | null;
    currentMcap: number | null;
    status: string;
    aiScore: number | null;
    aiVerdict: string | null;
  } | null> {
    const normalizedAddress = chain === 'EVM' ? address.toLowerCase() : address;
    const row = await this.prisma.intelSnapshot.findUnique({
      where: { chain_address: { chain, address: normalizedAddress } } as any,
      select: {
        id: true,
        capturedAt: true,
        marketCapUsdAtCapture: true,
        pumpedHigh: true,
        currentMcapUsd: true,
        status: true,
        aiScore: true,
        aiVerdict: true,
      },
    });
    if (!row) return null;
    return {
      id: row.id,
      capturedAt: row.capturedAt,
      mcapAtCapture: row.marketCapUsdAtCapture,
      pumpedHigh: row.pumpedHigh,
      currentMcap: row.currentMcapUsd,
      status: row.status,
      aiScore: row.aiScore,
      aiVerdict: row.aiVerdict,
    };
  }

  /**
   * Trim the heavy bits before persisting reportJson — saves ~70% of
   * row size and we don't need them for the marketing surface (the
   * frozen capture columns + the rescans table cover everything the
   * UI shows).
   */
  private slimReport(report: TokenAnalysisReport): Partial<TokenAnalysisReport> {
    return {
      meta: report.meta,
      safety: report.safety,
      kill: report.kill,
      aiReasoning: report.aiReasoning,
      generatedAt: report.generatedAt,
      providers: report.providers,
      // Drop: holderMetrics (huge), playbooks (recoverable), tradingStrategy,
      // comparableTokens, smartMoney (long lists), socialData details.
    };
  }

  /** Tail the most recent N pruned to short-of-graduated. Used by sidebar rail. */
  async listTop(limit = 5): Promise<Array<{
    id: string;
    chain: Chain;
    address: string;
    symbol: string | null;
    capturedAt: Date;
    mcapAtCapture: number | null;
    pumpedHigh: number | null;
    currentMcapUsd: number | null;
    deltaPct: number | null;
    sparkline: number[];
    status: string;
  }>> {
    const rows = await this.prisma.intelSnapshot.findMany({
      where: { status: { in: ['active', 'graduated'] } },
      orderBy: { pumpedHigh: 'desc' },
      take: limit,
      select: {
        id: true, chain: true, address: true, symbol: true,
        capturedAt: true, marketCapUsdAtCapture: true,
        pumpedHigh: true, currentMcapUsd: true, sparkline: true, status: true,
      },
    });
    return rows.map((r) => {
      const base = r.marketCapUsdAtCapture;
      const peak = r.pumpedHigh;
      const deltaPct = base && peak && base > 0 ? ((peak - base) / base) * 100 : null;
      return {
        id: r.id, chain: r.chain as Chain, address: r.address, symbol: r.symbol,
        capturedAt: r.capturedAt,
        mcapAtCapture: r.marketCapUsdAtCapture,
        pumpedHigh: r.pumpedHigh,
        currentMcapUsd: r.currentMcapUsd,
        deltaPct,
        sparkline: Array.isArray(r.sparkline) ? (r.sparkline as number[]) : [],
        status: r.status,
      };
    });
  }
}

export { SPARKLINE_MAX_POINTS };
