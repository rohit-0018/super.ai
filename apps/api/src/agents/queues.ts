import { Queue, QueueEvents, Worker, Processor } from 'bullmq';
import IORedis from 'ioredis';

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
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export function makeQueue(name: QueueName) {
  return new Queue(name, { connection });
}
export function makeWorker(name: QueueName, processor: Processor) {
  return new Worker(name, processor, { connection });
}
export function makeEvents(name: QueueName) {
  return new QueueEvents(name, { connection });
}
