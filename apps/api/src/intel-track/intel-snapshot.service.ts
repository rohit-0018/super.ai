import { Injectable, Logger, Optional } from '@nestjs/common';
import { Chain } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { TokenAnalysisReport } from '../token-analysis/token-analysis.types';
import { RealtimeGateway } from '../ws/realtime.gateway';

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

  constructor(
    private prisma: PrismaService,
    @Optional() private realtime?: RealtimeGateway,
  ) {}

  /**
   * Broadcast a freshly-created capture so the /hot-feed page can prepend a
   * card with fade-in animation. Optional/best-effort — if the WS isn't up
   * the capture still succeeds.
   */
  private emitCapture(snapshotId: string, source: IntelSource, symbol: string | null, address: string, chain: Chain): void {
    try {
      this.realtime?.emitGlobal('intel_capture_new', {
        id: snapshotId, source, symbol, address, chain, ts: new Date().toISOString(),
      });
    } catch { /* swallow — non-critical */ }
  }

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
      this.emitCapture(created.id, source, meta.symbol ?? null, normalizedAddress, chain);
      return { id: created.id, created: true };
    } catch (e: any) {
      this.logger.warn(`capture failed for ${address}: ${e.message}`);
      return null;
    }
  }

  /**
   * Lightweight capture path for callers that don't have a full
   * TokenAnalysisReport — currently used by the snipe pipeline so it can
   * record a track-record entry without taking a hard dependency on
   * TokenAnalysisModule (which would close a circular import). Stays
   * idempotent on (chain, address) just like capture().
   *
   * The snapshot it writes is intentionally thin (no AI fields, empty
   * report). The IntelRescanWorker will still tick it forward and the
   * marketing math (peak delta, current delta, sparkline) all keeps
   * working off the captured priceUsd / marketCapUsd anchor.
   */
  async captureMinimal(input: {
    chain: Chain;
    address: string;
    source: IntelSource;
    priceUsdAtCapture: number;
    marketCapUsdAtCapture?: number | null;
    liquidityUsdAtCapture?: number | null;
    symbol?: string | null;
    name?: string | null;
    userId?: string | null;
  }): Promise<{ id: string; created: boolean } | null> {
    if (!input.address || !Number.isFinite(input.priceUsdAtCapture) || input.priceUsdAtCapture <= 0) {
      return null;
    }
    const normalizedAddress = input.chain === 'EVM' ? input.address.toLowerCase() : input.address;
    try {
      const existing = await this.prisma.intelSnapshot.findUnique({
        where: { chain_address: { chain: input.chain, address: normalizedAddress } } as any,
      });
      if (existing) {
        await this.prisma.intelSnapshot.update({
          where: { id: existing.id },
          data: { reappearedAt: new Date(), reappearedSource: input.source },
        });
        return { id: existing.id, created: false };
      }
      const created = await this.prisma.intelSnapshot.create({
        data: {
          userId: input.userId ?? null,
          chain: input.chain,
          address: normalizedAddress,
          symbol: input.symbol ?? null,
          name: input.name ?? null,
          source: input.source,
          priceUsdAtCapture: input.priceUsdAtCapture,
          marketCapUsdAtCapture: input.marketCapUsdAtCapture ?? null,
          liquidityUsdAtCapture: input.liquidityUsdAtCapture ?? null,
          reportJson: {} as any,
          sparkline: input.marketCapUsdAtCapture != null ? [Math.round(input.marketCapUsdAtCapture)] : [],
          currentPriceUsd: input.priceUsdAtCapture,
          currentMcapUsd: input.marketCapUsdAtCapture ?? null,
          currentLiquidity: input.liquidityUsdAtCapture ?? null,
          pumpedHigh: input.marketCapUsdAtCapture ?? null,
          pumpedHighAt: input.marketCapUsdAtCapture != null ? new Date() : null,
          drawdownLow: input.marketCapUsdAtCapture ?? null,
          drawdownLowAt: input.marketCapUsdAtCapture != null ? new Date() : null,
        },
      });
      this.logger.log(
        `captureMinimal [${input.source}] ${input.symbol ?? normalizedAddress.slice(0, 8)} mcap=${input.marketCapUsdAtCapture ?? '?'}`,
      );
      this.emitCapture(created.id, input.source, input.symbol ?? null, normalizedAddress, input.chain);
      return { id: created.id, created: true };
    } catch (e: any) {
      this.logger.warn(`captureMinimal failed for ${input.address}: ${e.message}`);
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

  /**
   * One-shot backfill from the legacy TokenIntel table. We've been writing to
   * TokenIntel for months — those rows are the actual marketing data we want
   * on the track-record surface. Without backfill, /intel-track sits empty
   * until fresh captures from the new hooks start landing, which can take
   * hours or days depending on traffic.
   *
   * Idempotent — only runs when IntelSnapshot is empty. Each TokenIntel row
   * becomes a snapshot with source='manual_scan' (best approximation; the
   * legacy data didn't track entry source).
   */
  async backfillFromTokenIntel(): Promise<{ created: number; skipped: number; total: number }> {
    const existing = await this.prisma.intelSnapshot.count();
    if (existing > 0) {
      this.logger.log(`backfill skipped — IntelSnapshot already has ${existing} rows`);
      return { created: 0, skipped: existing, total: existing };
    }

    const intels = await this.prisma.tokenIntel.findMany({
      orderBy: { updatedAt: 'desc' },
      take: 500,
    });
    if (intels.length === 0) {
      this.logger.log('backfill found 0 TokenIntel rows — nothing to seed');
      return { created: 0, skipped: 0, total: 0 };
    }

    let created = 0, skipped = 0;
    for (const t of intels) {
      const priceUsd = (t as any).priceUsd as number | null;
      if (!priceUsd || !Number.isFinite(priceUsd) || priceUsd <= 0) { skipped++; continue; }
      const aiScore = (t as any).aiScore as number | null;
      const aiVerdict = (t as any).aiVerdict as string | null;
      const aiSummary = (t as any).aiSummary as string | null;
      const fullReport = (t as any).fullReport as any;
      const killTriggered = !!(t as any).killTriggered;

      // Apply same threshold as capture() so backfill respects user prefs.
      const passes =
        killTriggered ||
        (aiScore != null && aiScore >= MIN_AI_SCORE);
      if (!passes) { skipped++; continue; }

      try {
        await this.prisma.intelSnapshot.create({
          data: {
            chain: t.chain,
            address: t.address,
            symbol: t.symbol ?? null,
            name: t.name ?? null,
            source: 'manual_scan',
            capturedAt: t.updatedAt,
            priceUsdAtCapture: priceUsd,
            marketCapUsdAtCapture: null, // not stored on TokenIntel
            liquidityUsdAtCapture: null,
            reportJson: (fullReport ?? {}) as any,
            aiScore: aiScore ?? null,
            aiVerdict: aiVerdict ?? null,
            aiSummary: aiSummary ?? null,
            killTriggered,
            sparkline: [],
            currentPriceUsd: priceUsd,
            currentMcapUsd: null,
            pumpedHigh: null,
            drawdownLow: null,
          },
        });
        created++;
      } catch (e: any) {
        // Unique-constraint hits (chain,address) — already exists, count as skip.
        skipped++;
      }
    }
    this.logger.log(`backfill complete — created=${created} skipped=${skipped} of ${intels.length} TokenIntel rows`);
    return { created, skipped, total: intels.length };
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
    // Pull a wider set than `limit` and post-filter for ≥5% peak delta —
    // entries that haven't moved are noise, not track record. Returning
    // them on the sidebar rail makes the marketing surface look sad.
    const rows = await this.prisma.intelSnapshot.findMany({
      where: { status: { in: ['active', 'graduated'] } },
      orderBy: { pumpedHigh: 'desc' },
      take: Math.max(limit * 5, 20),
      select: {
        id: true, chain: true, address: true, symbol: true,
        capturedAt: true, marketCapUsdAtCapture: true,
        pumpedHigh: true, currentMcapUsd: true, sparkline: true, status: true,
      },
    });
    const filtered: typeof rows = [];
    for (const r of rows) {
      const base = r.marketCapUsdAtCapture;
      const peak = r.pumpedHigh;
      const deltaPct = base && peak && base > 0 ? ((peak - base) / base) * 100 : 0;
      if (deltaPct >= 5) filtered.push(r);
      if (filtered.length >= limit) break;
    }
    return filtered.map((r) => {
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
