import { Body, Controller, Get, HttpCode, Logger, Post } from '@nestjs/common';
import { TelegramService } from './telegram.service';

/**
 * Webhook receiver. In production (TELEGRAM_WEBHOOK_URL set), Telegram POSTs
 * updates to `/api/telegram/webhook`; we pipe them into the bot's update
 * dispatcher. In polling mode this endpoint is a harmless no-op.
 */
@Controller('telegram')
export class TelegramController {
  private readonly logger = new Logger(TelegramController.name);
  constructor(private readonly tg: TelegramService) {}

  @Post('webhook')
  @HttpCode(200)
  async webhook(@Body() update: any): Promise<{ ok: boolean }> {
    const bot = this.tg.getBot();
    if (!bot) return { ok: false };
    // Fire-and-forget: ack within Telegram's 60s webhook timeout regardless of
    // how long LLM/scan handling takes. Errors surface via grammy's bot.catch.
    bot.handleUpdate(update).catch((e) =>
      this.logger.error(`handleUpdate failed: ${(e as Error)?.message ?? e}`),
    );
    return { ok: true };
  }

  /**
   * Public bot identity. The web app calls this to build deep-links like
   * `https://t.me/<username>` without hard-coding the bot handle — works for
   * any deployment regardless of which bot token is configured.
   */
  @Get('me')
  async me(): Promise<{ username: string | null; firstName: string | null; id: number | null }> {
    return this.tg.getBotIdentity();
  }
}
