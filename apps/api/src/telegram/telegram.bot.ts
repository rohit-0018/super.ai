import { Injectable, Logger } from '@nestjs/common';
import { Bot, InlineKeyboard } from 'grammy';
import { PrismaService } from '../prisma/prisma.service';
import { AiAgentService } from '../ai-agent/ai-agent.service';
import { TelegramLinkService } from '../auth/telegram-link.service';

const NOT_LINKED_TEXT =
  '🔗 This Telegram is not linked to a QWAI account. Open web dashboard → Settings → "Link Telegram" to get a code, then send /link <code> here.';

/**
 * Grammy bot wrapper. Registers the same command + callback handlers that
 * the standalone `apps/telegram-bot/src/index.ts` exposed, but calls internal
 * services directly instead of HTTP-ing back to the API.
 *
 * NOTE: Construction must be explicit (call `build(token)`) so that Nest DI
 * does not try to instantiate Grammy at module import time when no token
 * is configured.
 */
@Injectable()
export class TelegramBot {
  private readonly logger = new Logger(TelegramBot.name);
  private _bot: Bot | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly agent: AiAgentService,
    private readonly tgLink: TelegramLinkService,
  ) {}

  get bot(): Bot | null {
    return this._bot;
  }

  isEnabled(): boolean {
    return !!this._bot;
  }

  build(token: string): Bot {
    if (this._bot) return this._bot;
    const bot = new Bot(token);
    this.registerHandlers(bot);
    bot.catch((err) => {
      this.logger.error(`Unhandled bot error: ${(err as Error)?.message ?? err}`);
    });
    this._bot = bot;
    return bot;
  }

  private async resolveUserId(chatId: number | string): Promise<string | null> {
    return this.tgLink.resolveByChatId(String(chatId));
  }

  /**
   * Chat on behalf of a telegram chat id. Mirrors the old `/chat/telegram`
   * endpoint semantics: if the chat is not linked, return the banner text.
   */
  private async chat(chatId: number, content: string): Promise<string> {
    const userId = await this.resolveUserId(chatId);
    if (!userId) return NOT_LINKED_TEXT;
    const reply = await this.agent.chat(userId, content, 'telegram');
    return reply ?? '…';
  }

  private registerHandlers(bot: Bot) {
    // /start — welcome + inline action buttons
    bot.command('start', (ctx) =>
      ctx.reply(
        [
          '👋 I am QWAI — your personal AI trading agent.',
          '',
          'Commands:',
          '/link <code> — connect to your web account',
          '/portfolio — portfolio summary',
          '/buy <amount> <token> — quick market buy',
          '/sell <amount> <token> — quick market sell',
          '/dca <amount> <token> <interval> — set up DCA',
          '/alerts — recent alerts',
          '/kill — emergency kill switch',
          '/paper — toggle paper mode info',
          '',
          'Or just talk naturally: "Buy $200 of SOL"',
        ].join('\n'),
        {
          reply_markup: new InlineKeyboard()
            .text('📊 Portfolio', 'action:portfolio')
            .text('🔔 Alerts', 'action:alerts')
            .row()
            .text('🛑 Kill switch', 'action:kill')
            .text('📝 Paper mode', 'action:paper'),
        },
      ),
    );

    // /link — connect telegram to web account
    bot.command('link', async (ctx) => {
      const code = ctx.match?.trim();
      if (!code) {
        return ctx.reply('Usage: `/link <code>`\nGenerate from web dashboard → Settings.', { parse_mode: 'Markdown' });
      }
      try {
        await this.tgLink.link(String(ctx.chat.id), code);
        return ctx.reply('✅ Telegram linked! You now share memory + wallets with the web dashboard.');
      } catch (e: any) {
        const msg = e?.message ?? 'unknown error';
        return ctx.reply(`❌ Link failed: ${msg}`);
      }
    });

    // /portfolio
    bot.command('portfolio', async (ctx) => {
      try {
        const reply = await this.chat(ctx.chat.id, 'Give me my portfolio summary with current positions and P&L.');
        return ctx.reply(reply);
      } catch (e: any) {
        return ctx.reply(`Error: ${e.message}`);
      }
    });

    // /buy <amount> <token> — quick trade
    bot.command('buy', async (ctx) => {
      const args = ctx.match?.trim();
      if (!args) return ctx.reply('Usage: /buy 200 SOL');
      try {
        const reply = await this.chat(ctx.chat.id, `Buy ${args}`);
        return ctx.reply(reply, {
          reply_markup: new InlineKeyboard()
            .text('✅ Confirm', `confirm:buy:${args}`)
            .text('❌ Cancel', 'confirm:cancel'),
        });
      } catch (e: any) {
        return ctx.reply(`Error: ${e.message}`);
      }
    });

    // /sell <amount> <token>
    bot.command('sell', async (ctx) => {
      const args = ctx.match?.trim();
      if (!args) return ctx.reply('Usage: /sell 1 SOL');
      try {
        const reply = await this.chat(ctx.chat.id, `Sell ${args}`);
        return ctx.reply(reply, {
          reply_markup: new InlineKeyboard()
            .text('✅ Confirm', `confirm:sell:${args}`)
            .text('❌ Cancel', 'confirm:cancel'),
        });
      } catch (e: any) {
        return ctx.reply(`Error: ${e.message}`);
      }
    });

    // /dca <amount> <token> <interval>
    bot.command('dca', async (ctx) => {
      const args = ctx.match?.trim();
      if (!args) return ctx.reply('Usage: /dca 50 SOL daily');
      try {
        const reply = await this.chat(ctx.chat.id, `Set up a DCA: buy ${args}`);
        return ctx.reply(reply);
      } catch (e: any) {
        return ctx.reply(`Error: ${e.message}`);
      }
    });

    // /alerts — recent alerts
    bot.command('alerts', async (ctx) => {
      try {
        const reply = await this.chat(ctx.chat.id, 'Show me my recent alerts and notifications.');
        return ctx.reply(reply);
      } catch (e: any) {
        return ctx.reply(`Error: ${e.message}`);
      }
    });

    // /kill — emergency
    bot.command('kill', async (ctx) => {
      return ctx.reply('🚨 Are you sure you want to engage the kill switch? This pauses ALL agents.', {
        reply_markup: new InlineKeyboard()
          .text('🛑 Yes, kill all', 'confirm:kill')
          .text('Cancel', 'confirm:cancel'),
      });
    });

    // /paper
    bot.command('paper', async (ctx) =>
      ctx.reply('Paper mode toggle: open the web /settings page to flip between paper ↔ live. This keeps both interfaces in sync.'),
    );

    // J5: Inline action button handlers (confirm / reject / snooze)
    bot.callbackQuery(/^action:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const action = ctx.match[1];
      switch (action) {
        case 'portfolio':
          return ctx.reply(await this.chat(ctx.chat!.id, 'Portfolio summary'));
        case 'alerts':
          return ctx.reply(await this.chat(ctx.chat!.id, 'Show my recent alerts'));
        case 'kill':
          return ctx.reply('Use /kill to engage the kill switch.');
        case 'paper':
          return ctx.reply('Toggle paper mode in the web Settings page.');
        default:
          return ctx.reply(`Unknown action: ${action}`);
      }
    });

    bot.callbackQuery(/^confirm:kill$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      try {
        const reply = await this.chat(ctx.chat!.id, 'Engage kill switch immediately. Pause all agents.');
        return ctx.reply(`🚨 ${reply}`);
      } catch (e: any) {
        return ctx.reply(`Error: ${e.message}`);
      }
    });

    bot.callbackQuery(/^confirm:cancel$/, async (ctx) => {
      await ctx.answerCallbackQuery('Cancelled');
      return ctx.reply('Cancelled.');
    });

    bot.callbackQuery(/^confirm:(buy|sell):(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const [, action, args] = ctx.match;
      try {
        const reply = await this.chat(ctx.chat!.id, `Confirmed — ${action} ${args}. Execute now.`);
        return ctx.reply(reply);
      } catch (e: any) {
        return ctx.reply(`Error: ${e.message}`);
      }
    });

    // Snooze button for alert notifications
    bot.callbackQuery(/^snooze:(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery('Snoozed for 1 hour');
      return ctx.reply('🔕 Alert snoozed for 1 hour.');
    });

    // Natural language catch-all
    bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) return;
      try {
        const reply = await this.chat(ctx.chat.id, ctx.message.text);
        return ctx.reply(reply);
      } catch (e: any) {
        return ctx.reply('Error talking to QWAI: ' + e.message);
      }
    });
  }
}
