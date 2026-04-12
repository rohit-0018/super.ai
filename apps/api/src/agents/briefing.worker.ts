import { Logger } from '@nestjs/common';
import { Worker } from 'bullmq';
import { makeQueue, makeWorker, QUEUES } from './queues';
import type { WorkerDeps } from './worker.bootstrap';

const BRIEFING_HOUR = 8; // local 08:00

export function startBriefingWorker(deps: WorkerDeps): Worker {
  const logger = new Logger('BriefingWorker');
  const queue = makeQueue(QUEUES.BRIEFING);

  return makeWorker(QUEUES.BRIEFING, async (job) => {
    // Per-user briefing job.
    if (job.name === 'briefing-user') {
      const { userId } = job.data as { userId: string };
      return deliverBriefing(deps, userId);
    }

    // Scheduler tick: find users whose local time is 08:00 and enqueue per-user jobs.
    // Timezone is stored on User.riskProfile.tz (falls back to UTC).
    const users = await deps.prisma.user.findMany({
      select: { id: true, riskProfile: true },
      take: 1000,
    });

    let queued = 0;
    for (const u of users) {
      const tz = extractTz(u.riskProfile) ?? 'UTC';
      const localHour = currentHourInTz(tz);
      if (localHour !== BRIEFING_HOUR) continue;

      // Dedupe: one briefing per user per day.
      const today = new Date().toISOString().slice(0, 10);
      const already = await deps.prisma.alertEvent.findFirst({
        where: {
          userId: u.id,
          kind: 'BRIEFING',
          createdAt: { gte: new Date(today + 'T00:00:00Z') },
        },
      });
      if (already) continue;

      await queue.add('briefing-user', { userId: u.id }, { removeOnComplete: 50 });
      queued++;
    }

    logger.debug(`briefing scheduler: queued ${queued}/${users.length}`);
    return { ok: true, queued };
  });
}

async function deliverBriefing(deps: WorkerDeps, userId: string) {
  const since = new Date(Date.now() - 24 * 3600_000);
  const [trades, orders, alerts] = await Promise.all([
    deps.prisma.trade.findMany({ where: { userId, createdAt: { gte: since } } }),
    deps.prisma.order.count({ where: { userId, status: 'FILLED', updatedAt: { gte: since } } }),
    deps.prisma.alertEvent.count({ where: { userId, createdAt: { gte: since } } }),
  ]);

  const pnl = trades.reduce((acc, t) => acc + (t.pnlUsd ?? 0), 0);
  const volume = trades.reduce((acc, t) => acc + (t.priceUsd ?? 0), 0);

  // H4: Market overview data
  let marketOverview: Record<string, unknown> = {};
  try {
    const trending = await deps.marketData.trending?.() ?? [];
    const topMovers = await deps.marketData.topMovers?.() ?? [];
    marketOverview = {
      trendingTokens: Array.isArray(trending) ? trending.slice(0, 5).map((t: any) => t?.item?.symbol ?? t?.symbol ?? '?') : [],
      topGainers: Array.isArray(topMovers) ? topMovers.slice(0, 3).map((m: any) => ({ symbol: m.symbol, pct24h: m.price_change_percentage_24h })) : [],
    };
  } catch {}

  const pnlDir = pnl >= 0 ? 'up' : 'down';
  const summary = `${trades.length} trades, ${orders} filled. Portfolio ${pnlDir} $${Math.abs(pnl).toFixed(2)}. ${alerts} alerts triggered. ${marketOverview.trendingTokens ? 'Trending: ' + (marketOverview.trendingTokens as string[]).join(', ') + '.' : ''}`;

  await deps.notifications.emit({
    userId,
    kind: 'BRIEFING',
    payload: {
      window: '24h',
      tradesCount: trades.length,
      filledOrders: orders,
      alertsCount: alerts,
      pnlUsd: Number(pnl.toFixed(2)),
      volumeUsd: Number(volume.toFixed(2)),
      market: marketOverview,
      summary,
    },
  });
  return { ok: true };
}

function extractTz(profile: unknown): string | null {
  if (!profile || typeof profile !== 'object') return null;
  const tz = (profile as Record<string, unknown>).tz;
  return typeof tz === 'string' ? tz : null;
}

function currentHourInTz(tz: string): number {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz });
    return parseInt(fmt.format(new Date()), 10);
  } catch {
    return new Date().getUTCHours();
  }
}
