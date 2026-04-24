import { Logger } from '@nestjs/common';
import { Chain } from '@prisma/client';
import { Worker } from 'bullmq';
import { makeWorker, QUEUES } from '../agents/queues';
import type { WorkerDeps } from '../agents/worker.bootstrap';
import { EpisodicMemoryService, DecisionContext } from './episodic-memory.service';
import { TokenIntelService } from '../token-intel/token-intel.service';
import { LlmService } from '../ai-agent/llm.service';
import { withTrace } from '../common/trace-context';

export interface EpisodeIngestDeps extends WorkerDeps {
  episodic: EpisodicMemoryService;
  tokenIntel?: TokenIntelService;
  llm: LlmService;
}

export interface EpisodeIngestJob {
  userId: string;
  tradeId: string | null;
  kind: 'EXECUTED' | 'PAPER' | 'APPROVED' | 'REJECTED';
  chain: Chain;
  token: string;
  side: 'buy' | 'sell';
  decisionSeed?: Record<string, unknown>;
  rejectReason?: string;
  traceId?: string;
}

export function startEpisodeIngestWorker(deps: EpisodeIngestDeps): Worker {
  const logger = new Logger('EpisodeIngestWorker');

  return makeWorker(QUEUES.EPISODE_INGEST, async (job) => {
    if (process.env.EPISODIC_MEMORY_ENABLED !== 'true') return { skipped: 'flag_off' };
    const data = job.data as EpisodeIngestJob;
    return withTrace(async () => {
      const cfg = await deps.prisma.learningConfig.findUnique({ where: { userId: data.userId } });
      if (!cfg?.enabled) return { skipped: 'learning_off' };

      const intel = await this_safeIntel(deps, data.chain, data.token);
      const context: DecisionContext = {
        priceUsd: intel?.priceUsd ?? null,
        marketCapUsd: asNumber((intel?.holderData as any)?.marketCapUsd),
        liquidityUsd: asNumber((intel?.holderData as any)?.liquidityUsd),
        holderCount: asNumber((intel?.holderData as any)?.holderCount),
        convictionScore: intel?.convictionScore ?? null,
        securityScore: intel?.securityScore ?? null,
        sentiment: (intel?.sentiment as any) ?? null,
        guardrail: null,
        seed: data.decisionSeed ?? {},
      };

      let rationale: string;
      if (data.kind === 'REJECTED') {
        rationale = `Rejected: ${data.rejectReason ?? 'no reason recorded'}`;
      } else {
        rationale = await rationalizeWithLlm(deps.llm, data, context).catch(() => fallbackRationale(data, context));
      }

      const id = await deps.episodic.writeEpisode({
        userId: data.userId,
        tradeId: data.tradeId,
        chain: data.chain,
        token: data.token,
        side: data.side,
        kind: data.kind,
        context,
        rationale,
      });
      if (!id) return { skipped: 'write_failed' };
      return { ok: true, id };
    }, { traceId: data.traceId, userId: data.userId });
  });
}

async function this_safeIntel(deps: EpisodeIngestDeps, chain: Chain, token: string) {
  if (!deps.tokenIntel) return null;
  try {
    return await deps.tokenIntel.analyze(chain, token);
  } catch {
    return null;
  }
}

function asNumber(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function rationalizeWithLlm(llm: LlmService, job: EpisodeIngestJob, ctx: DecisionContext): Promise<string> {
  const system = 'You are writing a one-sentence (≤200 chars) post-trade rationale. Plain English, no markdown.';
  const user = [
    `Action: ${job.kind} ${job.side} ${job.token} on ${job.chain}.`,
    `Price=${ctx.priceUsd ?? '?'}, Conviction=${ctx.convictionScore ?? '?'}, Security=${ctx.securityScore ?? '?'}, Liquidity=${ctx.liquidityUsd ?? '?'}.`,
    'Write one sentence on WHY the agent acted.',
  ].join(' ');
  const raw = await llm.chat([
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]);
  return raw.trim().slice(0, 400);
}

function fallbackRationale(job: EpisodeIngestJob, ctx: DecisionContext): string {
  return `${job.kind} ${job.side} ${job.token} (conv=${ctx.convictionScore ?? '?'}, price=${ctx.priceUsd ?? '?'})`;
}
