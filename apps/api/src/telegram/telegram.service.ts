import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import { makeQueue, QUEUES } from '../agents/queues';
import { TelegramBot } from './telegram.bot';

export interface TelegramSendOpts {
  parse_mode?: 'Markdown' | 'MarkdownV2' | 'HTML';
  disable_web_page_preview?: boolean;
  reply_markup?: unknown;
}

export interface TelegramSendJob {
  chatId: string | number;
  text: string;
  opts?: TelegramSendOpts;
}

/**
 * Public Telegram surface used by the rest of the API.
 *
 * - `enqueueSend` pushes an outbound message onto the `TELEGRAM_SEND` BullMQ
 *   queue so the trade / notification path never blocks on Telegram I/O.
 * - `startBot` / `stopBot` bring up the Grammy runtime. Webhook mode is used
 *   in production (if `TELEGRAM_WEBHOOK_URL` is set); long-polling is used
 *   locally (if `TELEGRAM_BOT_POLL=1` or no webhook is configured).
 */
@Injectable()
export class TelegramService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(TelegramService.name);
  private sendQueue: Queue | null = null;
  private started = false;

  // Explicit @Inject: TelegramBot's own forwardRef(ApprovalsService) corrupts
  // Reflect metadata so type inference alone fails to inject it here.
  constructor(@Inject(TelegramBot) private readonly tgBot: TelegramBot) {}

  async onModuleInit() {
    // Avoid double-bring-up in split api/worker topologies: the bot itself
    // only runs in the API process (it accepts updates / webhooks). The
    // worker process still needs the queue for enqueueing in case it
    // produces Telegram pushes (NotificationsService).
    const token = process.env.TELEGRAM_BOT_TOKEN;

    // Queue is always available so NotificationsService can enqueue from
    // either api or worker role.
    this.sendQueue = makeQueue(QUEUES.TELEGRAM_SEND);

    if (!token) {
      this.logger.warn('TELEGRAM_BOT_TOKEN missing — bot is idle.');
      return;
    }

    // Bot runtime lives in the API process (role=api or role=all). A pure
    // worker role still gets the queue above but never brings up Grammy.
    const role = process.env.QWAI_ROLE ?? 'all';
    if (role !== 'api' && role !== 'all' && role !== 'web') {
      this.logger.log(`QWAI_ROLE=${role}, skipping bot startBot (enqueue-only mode).`);
      return;
    }
    if (role === 'web') {
      // Web role = API replica without workers; still wants inbound updates.
      await this.startBot(token);
      return;
    }

    await this.startBot(token);
  }

  async onApplicationShutdown(signal?: string) {
    this.logger.log(`Telegram service shutting down (${signal ?? 'shutdown'})`);
    try {
      await this.stopBot();
    } catch (e) {
      this.logger.error(`Bot stop error: ${(e as Error).message}`);
    }
    try {
      await this.sendQueue?.close();
    } catch (e) {
      this.logger.error(`Queue close error: ${(e as Error).message}`);
    }
  }

  /**
   * Enqueue an outbound Telegram message. Non-blocking: returns as soon as
   * the job is accepted by Redis. Callers on the hot trade path can fire
   * this and move on.
   */
  async enqueueSend(
    chatId: string | number,
    text: string,
    opts?: TelegramSendOpts,
  ): Promise<void> {
    if (!this.sendQueue) {
      this.logger.warn('enqueueSend called before queue ready — dropping message.');
      return;
    }
    const payload: TelegramSendJob = { chatId, text, opts };
    await this.sendQueue.add('send', payload, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: 200,
      removeOnFail: 200,
    });
  }

  async startBot(token: string): Promise<void> {
    if (this.started) return;
    const bot = this.tgBot.build(token);
    const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL;
    const preferPolling = process.env.TELEGRAM_BOT_POLL === '1' || !webhookUrl;

    if (preferPolling) {
      // grammy's bot.start() returns a promise that only resolves on stop —
      // do not await it, let it run in the background.
      bot.start({
        onStart: () => this.logger.log('QWAI Telegram bot running (long-poll mode).'),
        allowed_updates: ['message', 'callback_query'],
      }).catch((e) => this.logger.error(`bot.start crashed: ${e?.message ?? e}`));
    } else {
      // Webhook mode. We only set the webhook; updates are piped in via
      // TelegramController -> bot.handleUpdate(update).
      try {
        await bot.init();
        await bot.api.setWebhook(webhookUrl!, { allowed_updates: ['message', 'callback_query'] });
        this.logger.log(`QWAI Telegram bot running (webhook ${webhookUrl}).`);
      } catch (e: any) {
        this.logger.error(`setWebhook failed: ${e.message}`);
        throw e;
      }
    }
    this.started = true;
  }

  async stopBot(): Promise<void> {
    if (!this.started) return;
    try {
      const bot = this.tgBot.bot;
      if (bot) {
        // `bot.stop()` tears down both long-poll and webhook runners safely.
        await bot.stop();
      }
    } finally {
      this.started = false;
    }
  }

  getBot() {
    return this.tgBot?.bot ?? null;
  }
}
