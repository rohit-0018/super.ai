import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SPARKLINE_MAX_POINTS } from './intel-snapshot.service';

const RESCAN_INTERVAL_SEC = parseInt(process.env.INTEL_RESCAN_INTERVAL_SEC ?? '600', 10);
const RESCAN_BATCH_SIZE = parseInt(process.env.INTEL_RESCAN_BATCH_SIZE ?? '60', 10);
const RESCAN_MAX_AGE_DAYS = parseInt(process.env.INTEL_RESCAN_MAX_AGE_DAYS ?? '30', 10);
const AUTO_PURGE = (process.env.INTEL_TRACK_AUTO_PURGE ?? 'false').toLowerCase() === 'true';

const RUGGED_LIQ_THRESHOLD_USD = 1_000;
const RUGGED_CONSECUTIVE_FAILS = 3;
const RETIRE_NO_RESPONSE_HOURS = 72;
const GRADUATED_PUMP_MULTIPLIER = 10; // 10x peak vs capture mcap = trophy

/**
 * IntelRescanWorker — periodic price-tick refresh + status auto-curation.
 *
 * Runs as a setInterval inside the API process (no BullMQ — keeps the worker
 * topology unchanged and avoids one more Redis subscription on the free plan).
 *
 * Each tick:
 *  1. Pick up to RESCAN_BATCH_SIZE active+graduated snapshots that haven't
 *     been rescanned in INTEL_RESCAN_INTERVAL_SEC. Older entries get priority.
 *  2. Fetch fresh price/mcap/liq from DexScreener (free, batched 30/req).
 *  3. Insert IntelRescan row, update aggregates (current*, pumpedHigh,
 *     drawdownLow, sparkline tail, rescanCount).
 *  4. Promote to 'graduated' if pumpedHigh >= 10× capture mcap.
 *  5. Demote to 'rugged' if 3 consecutive fetches show liquidity < $1k.
 *  6. Demote to 'retired' if last successful rescan was >72h ago.
 *  7. If INTEL_TRACK_AUTO_PURGE=true, hard-delete retired+rugged rows older
 *     than RESCAN_MAX_AGE_DAYS. Graduated trophies are NEVER purged.
 *
 * Tunables (all env-driven, no redeploys needed for changes):
 *   INTEL_RESCAN_INTERVAL_SEC      default 600   (10 min)
 *   INTEL_RESCAN_BATCH_SIZE        default 60
 *   INTEL_RESCAN_MAX_AGE_DAYS      default 30    (purge horizon)
 *   INTEL_TRACK_AUTO_PURGE         default false
 */
@Injectable()
export class IntelRescanWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IntelRescanWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private prisma: PrismaService) {}

  onModuleInit() {
    if (process.env.QWAI_ROLE && !['all', 'worker', 'api'].includes(process.env.QWAI_ROLE)) {
      this.logger.log(`QWAI_ROLE=${process.env.QWAI_ROLE} — IntelRescanWorker disabled`);
      return;
    }
    // First tick after 60s so boot isn't slowed; subsequent every interval.
    setTimeout(() => this.tick(), 60_000);
    this.timer = setInterval(() => this.tick(), RESCAN_INTERVAL_SEC * 1_000);
    this.logger.log(
      `IntelRescanWorker running (interval=${RESCAN_INTERVAL_SEC}s batch=${RESCAN_BATCH_SIZE} purge=${AUTO_PURGE})`,
    );
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return; // skip overlap
    this.running = true;
    const t0 = Date.now();
    try {
      const rescanned = await this.rescanBatch();
      const curated = await this.runStatusCuration();
      const purged = AUTO_PURGE ? await this.runPurge() : 0;
      this.logger.log(
        `tick: rescanned=${rescanned} curated=${curated} purged=${purged} ms=${Date.now() - t0}`,
      );
    } catch (e: any) {
      this.logger.warn(`tick failed: ${e.message}`);
    } finally {
      this.running = false;
    }
  }

  // ── 1. Rescan a batch of snapshots ─────────────────────────────────────
  private async rescanBatch(): Promise<number> {
    const stale = new Date(Date.now() - RESCAN_INTERVAL_SEC * 1_000);
    const rows = await this.prisma.intelSnapshot.findMany({
      where: {
        status: { in: ['active', 'graduated'] },
        OR: [{ lastRescannedAt: null }, { lastRescannedAt: { lt: stale } }],
      },
      orderBy: { lastRescannedAt: 'asc' },
      take: RESCAN_BATCH_SIZE,
      select: {
        id: true, chain: true, address: true,
        marketCapUsdAtCapture: true, pumpedHigh: true, drawdownLow: true,
        sparkline: true, status: true,
      },
    });
    if (rows.length === 0) return 0;

    // Group Solana mints into 30-per-call DexScreener requests. EVM addresses
    // also work on the same endpoint.
    const addresses = rows.map((r) => r.address);
    const priceMap = await this.batchPrices(addresses);
    const now = new Date();

    let updated = 0;
    for (const row of rows) {
      const data = priceMap.get(row.address);
      if (!data || data.priceUsd == null) continue;

      const captureMcap = row.marketCapUsdAtCapture ?? null;
      const newMcap = data.marketCapUsd ?? null;
      const newPumpedHigh = newMcap != null && (row.pumpedHigh == null || newMcap > row.pumpedHigh)
        ? newMcap : row.pumpedHigh;
      const pumpedHighAt = newMcap != null && (row.pumpedHigh == null || newMcap > row.pumpedHigh)
        ? now : undefined;
      const newDrawdown = newMcap != null && (row.drawdownLow == null || newMcap < row.drawdownLow)
        ? newMcap : row.drawdownLow;
      const drawdownLowAt = newMcap != null && (row.drawdownLow == null || newMcap < row.drawdownLow)
        ? now : undefined;

      // Update sparkline (capped at SPARKLINE_MAX_POINTS)
      const sparkArr = Array.isArray(row.sparkline) ? (row.sparkline as number[]).slice() : [];
      if (newMcap != null) {
        sparkArr.push(Math.round(newMcap));
        while (sparkArr.length > SPARKLINE_MAX_POINTS) sparkArr.shift();
      }

      // Auto-graduate if 10x peak.
      let nextStatus = row.status;
      if (
        nextStatus === 'active' &&
        captureMcap != null && newPumpedHigh != null &&
        captureMcap > 0 && newPumpedHigh / captureMcap >= GRADUATED_PUMP_MULTIPLIER
      ) {
        nextStatus = 'graduated';
      }

      try {
        await this.prisma.$transaction([
          this.prisma.intelRescan.create({
            data: {
              snapshotId: row.id,
              ts: now,
              priceUsd: data.priceUsd,
              marketCapUsd: data.marketCapUsd ?? null,
              liquidityUsd: data.liquidityUsd ?? null,
              volume24hUsd: data.volume24hUsd ?? null,
            },
          }),
          this.prisma.intelSnapshot.update({
            where: { id: row.id },
            data: {
              lastRescannedAt: now,
              currentPriceUsd: data.priceUsd,
              currentMcapUsd: newMcap,
              currentLiquidity: data.liquidityUsd ?? null,
              pumpedHigh: newPumpedHigh,
              ...(pumpedHighAt ? { pumpedHighAt } : {}),
              drawdownLow: newDrawdown,
              ...(drawdownLowAt ? { drawdownLowAt } : {}),
              sparkline: sparkArr as any,
              rescanCount: { increment: 1 },
              ...(nextStatus !== row.status ? { status: nextStatus } : {}),
            },
          }),
        ]);
        updated++;
      } catch (e: any) {
        this.logger.warn(`rescan persist failed for ${row.address}: ${e.message}`);
      }
    }
    return updated;
  }

  // ── 2. Status curation — rugged / retired demotions ────────────────────
  private async runStatusCuration(): Promise<number> {
    const cutoffRetire = new Date(Date.now() - RETIRE_NO_RESPONSE_HOURS * 3600_000);
    let touched = 0;

    // Retire: no rescan response in 72h. Means the token is delisted or the
    // address pattern stopped responding to DexScreener.
    const retireResult = await this.prisma.intelSnapshot.updateMany({
      where: {
        status: 'active',
        lastRescannedAt: { lt: cutoffRetire },
      },
      data: { status: 'retired' },
    });
    touched += retireResult.count;

    // Rugged: 3 consecutive rescans with liquidity < $1k means the LP was
    // pulled. Use a SQL aggregate to find these efficiently.
    const candidates = await this.prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT s.id
         FROM "IntelSnapshot" s
        WHERE s.status = 'active'
          AND (
            SELECT COUNT(*) FROM (
              SELECT r."liquidityUsd"
                FROM "IntelRescan" r
               WHERE r."snapshotId" = s.id
            ORDER BY r.ts DESC
               LIMIT $1
            ) t
            WHERE t."liquidityUsd" IS NOT NULL AND t."liquidityUsd" < $2
          ) >= $1`,
      RUGGED_CONSECUTIVE_FAILS, RUGGED_LIQ_THRESHOLD_USD,
    );
    if (candidates.length > 0) {
      const ruggedResult = await this.prisma.intelSnapshot.updateMany({
        where: { id: { in: candidates.map((c) => c.id) } },
        data: { status: 'rugged' },
      });
      touched += ruggedResult.count;
    }
    return touched;
  }

  // ── 3. Auto-purge (gated by INTEL_TRACK_AUTO_PURGE) ────────────────────
  private async runPurge(): Promise<number> {
    if (!AUTO_PURGE) return 0;
    const cutoff = new Date(Date.now() - RESCAN_MAX_AGE_DAYS * 86400_000);
    // NEVER purge graduated — those are the marketing trophies.
    const result = await this.prisma.intelSnapshot.deleteMany({
      where: {
        status: { in: ['retired', 'rugged'] },
        capturedAt: { lt: cutoff },
      },
    });
    if (result.count > 0) {
      this.logger.log(`auto-purged ${result.count} retired/rugged snapshots older than ${RESCAN_MAX_AGE_DAYS}d`);
    }
    return result.count;
  }

  // ── DexScreener batch pricing (free, no key, 30 mints/req) ─────────────
  private async batchPrices(addresses: string[]): Promise<Map<string, {
    priceUsd: number | null;
    marketCapUsd: number | null;
    liquidityUsd: number | null;
    volume24hUsd: number | null;
  }>> {
    const out = new Map<string, any>();
    for (let i = 0; i < addresses.length; i += 30) {
      const batch = addresses.slice(i, i + 30);
      try {
        const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${batch.join(',')}`, {
          signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok) continue;
        const json: any = await res.json();
        const pairs: any[] = Array.isArray(json?.pairs) ? json.pairs : [];
        // For each mint, keep the highest-liquidity pair.
        const byMint = new Map<string, any>();
        for (const p of pairs) {
          const m = p?.baseToken?.address;
          if (!m) continue;
          const cur = byMint.get(m);
          if (!cur || (p?.liquidity?.usd ?? 0) > (cur?.liquidity?.usd ?? 0)) byMint.set(m, p);
        }
        for (const a of batch) {
          const p = byMint.get(a);
          if (!p) {
            out.set(a, { priceUsd: null, marketCapUsd: null, liquidityUsd: null, volume24hUsd: null });
            continue;
          }
          out.set(a, {
            priceUsd: numOrNull(p.priceUsd),
            marketCapUsd: numOrNull(p.marketCap ?? p.fdv),
            liquidityUsd: numOrNull(p.liquidity?.usd),
            volume24hUsd: numOrNull(p.volume?.h24),
          });
        }
      } catch (e: any) {
        this.logger.debug(`dexscreener batch ${i}: ${e.message}`);
      }
    }
    return out;
  }
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
