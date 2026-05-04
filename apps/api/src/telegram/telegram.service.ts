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
  link_preview_options?: { is_disabled?: boolean };
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

  private webhookUrl: string | null = null;
  private webhookHealRunning = false;
  private webhookHealerInterval: NodeJS.Timeout | null = null;

  async startBot(token: string): Promise<void> {
    if (this.started) return;
    const bot = this.tgBot.build(token);
    // TELEGRAM_WEBHOOK_URL can be set directly, or derived from TELEGRAM_API_BASE_URL
    // (which Render auto-populates via fromService). Falls back to polling if neither is set.
    const webhookUrl =
      process.env.TELEGRAM_WEBHOOK_URL ||
      (process.env.TELEGRAM_API_BASE_URL
        ? `${process.env.TELEGRAM_API_BASE_URL.replace(/\/$/, '')}/api/telegram/webhook`
        : undefined);
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
        this.webhookUrl = webhookUrl!;
        this.logger.log(`QWAI Telegram bot running (webhook ${webhookUrl}).`);
        this.startWebhookHealer();
      } catch (e: any) {
        this.logger.error(`setWebhook failed: ${e.message}`);
        throw e;
      }
    }
    this.started = true;
  }

  /**
   * Self-healing webhook validator. Every 15 min, asks Telegram what URL it
   * thinks our webhook is. If it differs from what we set (because something
   * else called setWebhook — e.g. a local dev session, a previous deploy that
   * didn't get torn down, or a manual deleteWebhook for debugging), we re-set
   * it. Also surfaces last delivery error so it's visible in our own logs
   * instead of only via the Telegram API.
   */
  private startWebhookHealer(): void {
    if (this.webhookHealerInterval) return;
    this.webhookHealerInterval = setInterval(async () => {
      if (this.webhookHealRunning) return;
      this.webhookHealRunning = true;
      try {
        const bot = this.getBot();
        if (!bot || !this.webhookUrl) return;
        const info = await bot.api.getWebhookInfo();
        if (info.last_error_message) {
          this.logger.warn(
            `Telegram webhook last error: ${info.last_error_message} (pending=${info.pending_update_count})`,
          );
        }
        if (info.url !== this.webhookUrl) {
          this.logger.warn(
            `Webhook drift detected (telegram=${info.url || '<empty>'} expected=${this.webhookUrl}); re-registering`,
          );
          await bot.api.setWebhook(this.webhookUrl, { allowed_updates: ['message', 'callback_query'] });
        }
      } catch (e: any) {
        this.logger.warn(`Webhook healer tick failed: ${e.message}`);
      } finally {
        this.webhookHealRunning = false;
      }
    }, 15 * 60_000);
  }

  async stopBot(): Promise<void> {
    if (!this.started) return;
    if (this.webhookHealerInterval) {
      clearInterval(this.webhookHealerInterval);
      this.webhookHealerInterval = null;
    }
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

  /**
   * Returns the bot's public identity (username, first name, id). Used by the
   * web app to build correct deep-links to whichever bot is wired to this API.
   * Cached for 5 minutes — getMe is otherwise hit on every link page load.
   */
  private cachedIdentity: { username: string | null; firstName: string | null; id: number | null; ts: number } | null = null;
  async getBotIdentity(): Promise<{ username: string | null; firstName: string | null; id: number | null }> {
    const now = Date.now();
    if (this.cachedIdentity && now - this.cachedIdentity.ts < 5 * 60_000) {
      const { username, firstName, id } = this.cachedIdentity;
      return { username, firstName, id };
    }
    const bot = this.getBot();
    if (!bot) return { username: null, firstName: null, id: null };
    try {
      const me = await bot.api.getMe();
      const identity = { username: me.username ?? null, firstName: me.first_name ?? null, id: me.id ?? null, ts: now };
      this.cachedIdentity = identity;
      const { username, firstName, id } = identity;
      return { username, firstName, id };
    } catch (e: any) {
      this.logger.warn(`getMe failed: ${e.message}`);
      return { username: null, firstName: null, id: null };
    }
  }
}
