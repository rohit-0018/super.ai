import { Queue, QueueEvents, Worker, Processor } from 'bullmq';
import IORedis from 'ioredis';
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'path';
for (const p of [resolve(process.cwd(), '.env'), resolve(__dirname, '../../../../.env')]) {
  loadDotenv({ path: p });
}
import { currentTraceId, newTraceId } from '../common/trace-context';

export const connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

export const QUEUES = {
  DCA: 'dca',
  STOP_LOSS: 'stop-loss',
  POSITION_MONITOR: 'position-monitor',
  COPY_TRADE: 'copy-trade',
  SNIPE: 'snipe',
  BRIEFING: 'briefing',
  NOTIFICATIONS: 'notifications',
  TELEGRAM_SEND: 'telegram-send',
  LEARNING_INGEST: 'learning-ingest',
  STRATEGY_SCORER: 'strategy-scorer',
  STRATEGY_PERFORMANCE: 'strategy-performance',
  AUTONOMOUS_TRADER: 'autonomous-trader',
  APPROVAL_EXPIRER: 'approval-expirer',
  INTENT_EXTRACT_CHAT: 'intent-extract-chat',
  INTENT_EXTRACT_REJECTION: 'intent-extract-rejection',
  INTENT_RETIRE_STALE: 'intent-retire-stale',
  CONVERSATION_SUMMARIZE: 'conversation-summarize',
  CONVERSATION_IDLE_SWEEP: 'conversation-idle-sweep',
  NOTE_EXTRACT: 'note-extract',
  NOTE_RETIRE_STALE: 'note-retire-stale',
  EPISODE_INGEST: 'episode-ingest',
  EPISODE_OUTCOME: 'episode-outcome',
  CONVICTION_LEARNER: 'conviction-learner',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export function makeQueue(name: QueueName) {
  return new Queue(name, { connection });
}
export function makeWorker(name: QueueName, processor: Processor, opts: Record<string, unknown> = {}) {
  return new Worker(name, processor, { connection, ...opts });
}
export function makeEvents(name: QueueName) {
  return new QueueEvents(name, { connection });
}

/**
 * Enrich arbitrary job data with a traceId so the producing request's trace
 * continues across the BullMQ boundary. If no ambient traceId is active
 * (e.g. a scheduled tick) a fresh one is generated so the job still has a
 * handle consumers can re-enter a trace scope with.
 */
export function makeJobData<T extends Record<string, unknown>>(
  data: T = {} as T,
): T & { traceId: string } {
  const traceId = currentTraceId() ?? newTraceId();
  return { ...data, traceId };
}

/**
 * Convenience wrapper that returns both merged `data` (with traceId) and
 * untouched `opts`, for use with `queue.add(name, data, opts)`.
 */
export function makeJobOpts<T extends Record<string, unknown>>(
  input: { data?: T; opts?: Record<string, unknown> } = {},
): { data: T & { traceId: string }; opts: Record<string, unknown> } {
  return {
    data: makeJobData<T>((input.data ?? {}) as T),
    opts: input.opts ?? {},
  };
}
