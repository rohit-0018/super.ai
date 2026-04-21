import { Logger } from '@nestjs/common';
import { Bot } from 'grammy';
import { Worker } from 'bullmq';
import { makeWorker, QUEUES } from '../agents/queues';
import { withRetry } from '../common/retry';
import type { TelegramSendJob } from './telegram.service';

export interface TelegramWorkerDeps {
  /**
   * We need a Grammy client to call `sendMessage`. In practice this is the
   * same `Bot` instance managed by TelegramService, but a worker-only
   * process may instantiate a bare `new Bot(token)` and reuse it purely for
   * outbound API calls (no update handlers, no polling).
   */
  bot: Bot;
}

/**
 * BullMQ worker for outbound Telegram messages. Each job carries chatId,
 * text, and opts; we call `bot.api.sendMessage` wrapped in the standard
 * retry helper (3 attempts, exponential backoff).
 */
export function startTelegramWorker(deps: TelegramWorkerDeps): Worker {
  const logger = new Logger('TelegramWorker');

  return makeWorker(QUEUES.TELEGRAM_SEND, async (job) => {
    const { chatId, text, opts } = job.data as TelegramSendJob;
    await withRetry(
      () => deps.bot.api.sendMessage(chatId, text, opts as any),
      { attempts: 3, delayMs: 1000, label: `telegram.sendMessage(chat=${chatId})` },
    );
    logger.debug(`sent tg message chat=${chatId} len=${text.length}`);
    return { ok: true };
  });
}
