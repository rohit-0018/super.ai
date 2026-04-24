import { Logger } from '@nestjs/common';
import { ApprovalStatus, AutonomyLevel, Prisma, StrategyPerformance } from '@prisma/client';
import { Worker } from 'bullmq';
import { makeWorker, QUEUES } from './queues';
import type { WorkerDeps } from './worker.bootstrap';
import { LlmService } from '../ai-agent/llm.service';
import { TradingDnaService } from '../ai-agent/trading-dna.service';
import { StrategyPerformanceService } from '../strategies/strategy-performance.service';
import { withTrace } from '../common/trace-context';

export interface StrategyScorerDeps extends WorkerDeps {
  llm: LlmService;
  dna: TradingDnaService;
  strategyPerf: StrategyPerformanceService;
}

interface LlmQualitative {
  score: number; // 0..1
  rationale: string;
}

interface ScoreBreakdown {
  sharpeNorm: number;
  winRate: number;
  acceptRate: number;
  llmQualitative: number;
  sampleCount: number;
  flags: string[];
}

const MIN_SAMPLES_FOR_COMPOSITE = 5;

/**
 * Recomputes every enabled strategy's composite score (0..1):
 *   0.45 * sharpeNorm + 0.25 * winRate + 0.20 * acceptRate + 0.10 * llmQualitative
 *
 * When sampleCount < 5, writes score=0.5 with flag INSUFFICIENT_DATA and skips
 * the LLM call to save cost. The LLM is fed real metrics + recent rejection
 * categories so the qualitative grade is grounded, not pure vibes.
 */
export function startStrategyScorerWorker(deps: StrategyScorerDeps): Worker {
  const logger = new Logger('StrategyScorerWorker');

  return makeWorker(QUEUES.STRATEGY_SCORER, async (job) => {
    const jobTrace: string | undefined = (job.data as { traceId?: string } | undefined)?.traceId;
    return withTrace(async () => {
      const configs = await deps.prisma.learningConfig.findMany({
        where: { enabled: true, autonomyLevel: { not: AutonomyLevel.MANUAL } },
      });
      if (!configs.length) return { scored: 0 };

      let scored = 0;
      for (const cfg of configs) {
        const strategies = await deps.prisma.userStrategy.findMany({
          where: { userId: cfg.userId, enabled: true },
          include: { performance: true },
          take: 10,
        });
        if (!strategies.length) continue;

        for (const s of strategies) {
          try {
            // Ensure perf is fresh; cheap upsert so we're not reading 10-min-stale aggregates.
            const perf = s.performance ?? (await deps.strategyPerf.upsertFor(s.id, cfg.userId));
            if ((perf.sampleCount ?? 0) < MIN_SAMPLES_FOR_COMPOSITE) {
              await deps.prisma.userStrategy.update({
                where: { id: s.id },
                data: {
                  score: 0.5,
                  scoreBreakdown: {
                    sharpeNorm: 0,
                    winRate: 0,
                    acceptRate: 0,
                    llmQualitative: 0,
                    sampleCount: perf.sampleCount ?? 0,
                    flags: ['INSUFFICIENT_DATA'],
                  } satisfies ScoreBreakdown as unknown as Prisma.InputJsonValue,
                  lastScoredAt: new Date(),
                },
              });
              scored++;
              continue;
            }

            const rejections = await deps.prisma.approvalRequest.findMany({
              where: { strategyId: s.id, status: ApprovalStatus.REJECTED },
              select: { rejectCategory: true, rejectReason: true },
              orderBy: { respondedAt: 'desc' },
              take: 10,
            });

            const dnaProfile = await deps.dna.profileForPrompt(cfg.userId);
            const qualitative = await gradeStrategy(deps.llm, s.name, s.definition, dnaProfile, perf, rejections).catch((e) => {
              logger.warn(`llm grade strategy=${s.id} failed: ${e.message}`);
              return { score: 0.5, rationale: 'llm_unavailable' } as LlmQualitative;
            });

            const sharpeNorm = this_sharpeNorm(perf);
            const winRate = perf.wins + perf.losses > 0 ? perf.wins / (perf.wins + perf.losses) : 0.5;
            const acceptRate = perf.approvalAcceptRate ?? 0.5;
            const composite = 0.45 * sharpeNorm + 0.25 * winRate + 0.20 * acceptRate + 0.10 * qualitative.score;

            await deps.prisma.userStrategy.update({
              where: { id: s.id },
              data: {
                score: Math.max(0, Math.min(1, composite)),
                scoreBreakdown: {
                  sharpeNorm,
                  winRate,
                  acceptRate,
                  llmQualitative: qualitative.score,
                  sampleCount: perf.sampleCount,
                  flags: [],
                } satisfies ScoreBreakdown as unknown as Prisma.InputJsonValue,
                lastRationale: qualitative.rationale.slice(0, 500),
                lastScoredAt: new Date(),
              },
            });
            scored++;
          } catch (err: any) {
            logger.warn(`score strategy=${s.id} failed: ${err.message}`);
          }
        }
      }
      logger.debug(`scored ${scored} strategies across ${configs.length} users`);
      return { scored };
    }, { traceId: jobTrace });
  });
}

// Sharpe = avgPnl / (stdevPnl + ε), clipped [-3, 3], mapped to [0, 1].
function this_sharpeNorm(perf: StrategyPerformance): number {
  const sharpe = perf.avgPnlUsd / (perf.stdevPnlUsd + 1e-6);
  const clipped = Math.max(-3, Math.min(3, sharpe));
  return (clipped + 3) / 6;
}

async function gradeStrategy(
  llm: LlmService,
  name: string,
  definition: Prisma.JsonValue,
  dnaProfile: string,
  perf: StrategyPerformance,
  rejections: Array<{ rejectCategory: string | null; rejectReason: string | null }>,
): Promise<LlmQualitative> {
  const def = (definition ?? {}) as { prompt?: string; trigger?: unknown; notes?: string };
  const system = [
    'You are a trading-strategy qualitative grader.',
    'Output ONLY a single JSON line: {"score": <0-1 number>, "rationale": "<one sentence>"}.',
    'Grade how well the strategy rule matches the user\'s trading DNA and recent performance data below.',
    'Heavy penalty for vague rules ("buy winners"). Heavy penalty when many rejections share the same category.',
    'Do not output markdown fences or prose outside the JSON.',
  ].join(' ');
  const metricsBlock = {
    sampleCount: perf.sampleCount,
    wins: perf.wins,
    losses: perf.losses,
    totalPnlUsd: Math.round(perf.totalPnlUsd * 100) / 100,
    avgPnlUsd: Math.round(perf.avgPnlUsd * 100) / 100,
    stdevPnlUsd: Math.round(perf.stdevPnlUsd * 100) / 100,
    maxDrawdownUsd: Math.round(perf.maxDrawdownUsd * 100) / 100,
    approvalAcceptRate: perf.approvalAcceptRate,
  };
  const user = [
    `Strategy: ${name}`,
    `Rule: ${def.prompt ?? '(no rule)'}`,
    def.notes ? `Notes: ${def.notes}` : '',
    `Trading DNA: ${dnaProfile}`,
    `Metrics: ${JSON.stringify(metricsBlock)}`,
    rejections.length
      ? `Recent rejections: ${JSON.stringify(rejections.slice(0, 5).map((r) => ({ c: r.rejectCategory, r: r.rejectReason?.slice(0, 80) })))}`
      : '',
  ].filter(Boolean).join('\n');

  const raw = await llm.chat([
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]);

  const match = raw.match(/\{[\s\S]*?\}/);
  if (!match) return { score: 0.5, rationale: 'grader returned non-JSON; defaulting' };
  try {
    const parsed = JSON.parse(match[0]);
    const score = Math.max(0, Math.min(1, Number(parsed.score) || 0));
    const rationale = String(parsed.rationale ?? '').trim() || 'no rationale provided';
    return { score, rationale };
  } catch {
    return { score: 0.5, rationale: 'grader JSON parse failed; defaulting' };
  }
}
