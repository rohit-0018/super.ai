import { forwardRef, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Bot, InlineKeyboard } from 'grammy';
import { ApprovalChannel, RejectCategory } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AiAgentService } from '../ai-agent/ai-agent.service';
import { TelegramLinkService } from '../auth/telegram-link.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { SnipeGroupService } from '../snipe/snipe-group.service';

const NOT_LINKED_TEXT =
  '🔗 This Telegram is not linked to a QWAI account. Open web dashboard → Settings → "Link Telegram" to get a code, then send /link <code> here.';

@Injectable()
export class TelegramBot {
  private readonly logger = new Logger(TelegramBot.name);
  private _bot: Bot | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly agent: AiAgentService,
    private readonly tgLink: TelegramLinkService,
    @Inject(forwardRef(() => ApprovalsService))
    private readonly approvals: ApprovalsService,
    @Optional() private readonly snipeGroup: SnipeGroupService,
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
          '/snipe — sniper bot commands',
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
        return ctx.reply(`❌ Link failed: ${e?.message ?? 'unknown error'}`);
      }
    });

    // /portfolio
    bot.command('portfolio', async (ctx) => {
      try {
        return ctx.reply(await this.chat(ctx.chat.id, 'Give me my portfolio summary with current positions and P&L.'));
      } catch (e: any) {
        return ctx.reply(`Error: ${e.message}`);
      }
    });

    // /buy <amount> <token>
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
        return ctx.reply(await this.chat(ctx.chat.id, `Set up a DCA: buy ${args}`));
      } catch (e: any) {
        return ctx.reply(`Error: ${e.message}`);
      }
    });

    // /alerts
    bot.command('alerts', async (ctx) => {
      try {
        return ctx.reply(await this.chat(ctx.chat.id, 'Show me my recent alerts and notifications.'));
      } catch (e: any) {
        return ctx.reply(`Error: ${e.message}`);
      }
    });

    // /kill
    bot.command('kill', async (ctx) =>
      ctx.reply('🚨 Are you sure you want to engage the kill switch? This pauses ALL agents.', {
        reply_markup: new InlineKeyboard()
          .text('🛑 Yes, kill all', 'confirm:kill')
          .text('Cancel', 'confirm:cancel'),
      }),
    );

    // /paper
    bot.command('paper', async (ctx) =>
      ctx.reply('Paper mode toggle: open the web /settings page to flip between paper ↔ live. This keeps both interfaces in sync.'),
    );

    // /snipe — show sniper status + help
    bot.command('snipe', async (ctx) => {
      const userId = await this.resolveUserId(ctx.chat.id);
      if (!userId) return ctx.reply(NOT_LINKED_TEXT);

      const config = await this.prisma.snipeConfig.findUnique({ where: { userId } });
      const lines = [
        '⚡ *Sniper Bot*',
        '',
        config
          ? [
              `Status: ${config.enabled ? '🟢 Enabled' : '🔴 Disabled'}`,
              `Chain: ${config.chain}`,
              `Buy amount: ${(Number(config.buyAmountRaw) / 1e9).toFixed(4)} SOL`,
              `Slippage: ${(config.maxSlippageBps / 100).toFixed(0)}%`,
              `Groups: ${config.groupIds.length} monitored`,
            ].join('\n')
          : 'No config yet. Use /snipe\\_start or REST API POST /api/snipe/config',
        '',
        'Commands:',
        '/snipe\\_on — enable + start hot session',
        '/snipe\\_off — disable + stop session',
        '/snipe\\_status — session status',
      ];
      return ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
    });

    // /snipe_on — enable sniper (requires existing config with walletId)
    bot.command('snipe_on', async (ctx) => {
      const userId = await this.resolveUserId(ctx.chat.id);
      if (!userId) return ctx.reply(NOT_LINKED_TEXT);
      try {
        const config = await this.prisma.snipeConfig.findUnique({ where: { userId } });
        if (!config) return ctx.reply('No snipe config found. Configure at /api/snipe/config first.');
        await this.prisma.snipeConfig.update({ where: { userId }, data: { enabled: true } });
        return ctx.reply(`✅ Sniper enabled. Add this bot to your groups, make sure privacy mode is OFF in BotFather.\n\nHot session starts automatically when the bot receives a group message for your user.`, { parse_mode: 'Markdown' });
      } catch (e: any) {
        return ctx.reply(`Error: ${e.message}`);
      }
    });

    // /snipe_off — disable sniper
    bot.command('snipe_off', async (ctx) => {
      const userId = await this.resolveUserId(ctx.chat.id);
      if (!userId) return ctx.reply(NOT_LINKED_TEXT);
      try {
        await this.prisma.snipeConfig.updateMany({ where: { userId }, data: { enabled: false } });
        this.snipeGroup?.stopUserSession(userId);
        return ctx.reply('🔴 Sniper disabled.');
      } catch (e: any) {
        return ctx.reply(`Error: ${e.message}`);
      }
    });

    // /snipe_status
    bot.command('snipe_status', async (ctx) => {
      const userId = await this.resolveUserId(ctx.chat.id);
      if (!userId) return ctx.reply(NOT_LINKED_TEXT);
      const status = this.snipeGroup
        ? this.snipeGroup.getUserSessionStatus(userId)
        : { active: false };
      const config = await this.prisma.snipeConfig.findUnique({ where: { userId } });
      return ctx.reply(
        [
          `Session: ${status.active ? `🟢 Active (expires ${new Date((status as any).expiresAt).toISOString()})` : '🔴 No hot session'}`,
          `Sniper: ${config?.enabled ? '🟢 Enabled' : '🔴 Disabled'}`,
          `Groups: ${config?.groupIds?.join(', ') || 'none'}`,
        ].join('\n'),
      );
    });

    // ── Inline callbacks ──

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
        return ctx.reply(`🚨 ${await this.chat(ctx.chat!.id, 'Engage kill switch immediately. Pause all agents.')}`);
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
        return ctx.reply(await this.chat(ctx.chat!.id, `Confirmed — ${action} ${args}. Execute now.`));
      } catch (e: any) {
        return ctx.reply(`Error: ${e.message}`);
      }
    });

    bot.callbackQuery(/^approve:([\w-]+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const [, requestId] = ctx.match;
      const userId = await this.resolveUserId(ctx.chat!.id);
      if (!userId) return ctx.reply(NOT_LINKED_TEXT);
      try {
        await this.approvals.respond(userId, requestId, true, ApprovalChannel.TELEGRAM);
        return ctx.reply('✅ Approved. Executing.');
      } catch (e: any) {
        return ctx.reply(`Error: ${e.message}`);
      }
    });

    bot.callbackQuery(/^reject:([\w-]+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const [, requestId] = ctx.match;
      const keyboard = new InlineKeyboard()
        .text('Too risky', `reject_reason:${requestId}:TOO_RISKY`)
        .text('Wrong token', `reject_reason:${requestId}:WRONG_TOKEN`)
        .row()
        .text('Bad timing', `reject_reason:${requestId}:BAD_TIMING`)
        .text('Wrong size', `reject_reason:${requestId}:WRONG_SIZE`)
        .row()
        .text('Other', `reject_reason:${requestId}:OTHER`);
      return ctx.reply('Why are you rejecting?', { reply_markup: keyboard });
    });

    bot.callbackQuery(/^reject_reason:([\w-]+):(TOO_RISKY|WRONG_TOKEN|BAD_TIMING|WRONG_SIZE|OTHER)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const [, requestId, category] = ctx.match;
      const userId = await this.resolveUserId(ctx.chat!.id);
      if (!userId) return ctx.reply(NOT_LINKED_TEXT);
      try {
        await this.approvals.respond(userId, requestId, false, ApprovalChannel.TELEGRAM, {
          rejectCategory: category as RejectCategory,
        });
        return ctx.reply(`❌ Rejected (${category.toLowerCase().replace('_', ' ')}).`);
      } catch (e: any) {
        return ctx.reply(`Error: ${e.message}`);
      }
    });

    bot.callbackQuery(/^snooze:(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery('Snoozed for 1 hour');
      return ctx.reply('🔕 Alert snoozed for 1 hour.');
    });

    // ── Group / channel message handler (sniper hot path) ──
    // Runs BEFORE the catch-all so group messages never hit the AI.

    bot.on('channel_post:text', async (ctx) => {
      if (!this.snipeGroup) return;
      const groupId = String(ctx.chat.id);
      const text = ctx.channelPost.text ?? '';
      this.snipeGroup.handleGroupMessage(groupId, text).catch((e) =>
        this.logger.error(`snipeGroup channel_post error: ${e.message}`),
      );
    });

    // Natural language + group catch-all
    bot.on('message:text', async (ctx) => {
      const chatType = ctx.chat.type;

      // Group/supergroup messages: check for CA and run sniper; don't reply
      if ((chatType === 'group' || chatType === 'supergroup') && this.snipeGroup) {
        const groupId = String(ctx.chat.id);
        const text = ctx.message.text ?? '';
        this.snipeGroup.handleGroupMessage(groupId, text).catch((e) =>
          this.logger.error(`snipeGroup message error: ${e.message}`),
        );
        return;
      }

      // Private chat: route to AI as before
      if (ctx.message.text.startsWith('/')) return;
      try {
        return ctx.reply(await this.chat(ctx.chat.id, ctx.message.text));
      } catch (e: any) {
        return ctx.reply('Error talking to QWAI: ' + e.message);
      }
    });
  }
}
