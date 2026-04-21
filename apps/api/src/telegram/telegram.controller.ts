import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { TelegramService } from './telegram.service';

/**
 * Webhook receiver. In production (TELEGRAM_WEBHOOK_URL set), Telegram POSTs
 * updates to `/api/telegram/webhook`; we pipe them into the bot's update
 * dispatcher. In polling mode this endpoint is a harmless no-op.
 */
@Controller('telegram')
export class TelegramController {
  constructor(private readonly tg: TelegramService) {}

  @Post('webhook')
  @HttpCode(200)
  async webhook(@Body() update: any): Promise<{ ok: boolean }> {
    const bot = this.tg.getBot();
    if (!bot) return { ok: false };
    await bot.handleUpdate(update);
    return { ok: true };
  }
}
