import { Logger } from '@nestjs/common';
import { Worker } from 'bullmq';
import { makeWorker, QUEUES } from '../agents/queues';
import type { WorkerDeps } from '../agents/worker.bootstrap';
import { TokenIntelService } from '../token-intel/token-intel.service';
import { withTrace } from '../common/trace-context';

export interface EpisodeOutcomeDeps extends WorkerDeps {
  tokenIntel?: TokenIntelService;
}

// Fills outcome1h / outcome24h on past TradeEpisodes. Runs every 5 min.
// Windows are slightly padded so a missed tick still catches rows on the
// next run. Episodes stuck >48h with no price are marked skipped so
// findSimilar stops ignoring them forever.
export function startEpisodeOutcomeWorker(deps: EpisodeOutcomeDeps): Worker {
  const logger = new Logger('EpisodeOutcomeWorker');

  return makeWorker(QUEUES.EPISODE_OUTCOME, async (job) => {
    if (process.env.EPISODIC_MEMORY_ENABLED !== 'true') return { skipped: 'flag_off' };
    const traceId = (job.data as { traceId?: string } | undefined)?.traceId;
    return withTrace(async () => {
      const filled1h = await fillWindow(deps, 55, 70, '1h', logger);
      const filled24h = await fillWindow(deps, 23 * 60, 25 * 60, '24h', logger);
      const skipped = await markAbandoned(deps, logger);
      return { filled1h, filled24h, skipped };
    }, { traceId });
  });
}

async function fillWindow(deps: EpisodeOutcomeDeps, minAgoMin: number, maxAgoMin: number, field: '1h' | '24h', logger: Logger) {
  const minDate = new Date(Date.now() - maxAgoMin * 60_000);
  const maxDate = new Date(Date.now() - minAgoMin * 60_000);
  const rows = await deps.prisma.tradeEpisode.findMany({
    where: {
      createdAt: { gte: minDate, lte: maxDate },
      ...(field === '1h' ? { outcome1h: { equals: null as any } } : { outcome24h: { equals: null as any } }),
    },
    select: { id: true, chain: true, token: true, decisionContext: true },
    take: 100,
  });
  let filled = 0;
  for (const r of rows) {
    const ctx = r.decisionContext as any;
    const priceAtDecision = Number(ctx?.priceUsd);
    if (!Number.isFinite(priceAtDecision) || priceAtDecision <= 0) continue;
    const intel = await safeIntel(deps, r.chain, r.token);
    const nowPrice = Number(intel?.priceUsd);
    if (!Number.isFinite(nowPrice) || nowPrice <= 0) continue;
    const priceDeltaPct = ((nowPrice - priceAtDecision) / priceAtDecision) * 100;
    const outcome = { priceDeltaPct, priceUsdAt: nowPrice, computedAt: new Date().toISOString() };
    await deps.prisma.tradeEpisode.update({
      where: { id: r.id },
      data: field === '1h' ? { outcome1h: outcome as any } : { outcome24h: outcome as any },
    });
    filled++;
  }
  return filled;
}

async function markAbandoned(deps: EpisodeOutcomeDeps, logger: Logger): Promise<number> {
  const cutoff = new Date(Date.now() - 48 * 3600_000);
  const rows = await deps.prisma.tradeEpisode.updateMany({
    where: { createdAt: { lt: cutoff }, outcome1h: { equals: null as any } },
    data: { outcome1h: { skipped: 'price_unavailable' } as any },
  });
  return rows.count;
}

async function safeIntel(deps: EpisodeOutcomeDeps, chain: string, token: string) {
  if (!deps.tokenIntel) return null;
  try {
    return await deps.tokenIntel.analyze(chain as any, token);
  } catch {
    return null;
  }
}
