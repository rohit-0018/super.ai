import { forwardRef, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Bot, InlineKeyboard } from 'grammy';
import { ApprovalChannel, RejectCategory } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AiAgentService } from '../ai-agent/ai-agent.service';
import { TelegramLinkService } from '../auth/telegram-link.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { SnipeGroupService } from '../snipe/snipe-group.service';
import { detectChain } from '../token-analysis/chain-detector';
import { TokenAnalysisService } from '../token-analysis/token-analysis.service';
import {
  formatScanReport,
  formatKillReport,
  formatPlaceholder,
} from './telegram-scan.formatter';

const NOT_LINKED_TEXT =
  '🔗 This Telegram is not linked to a QWAI account.\n\nOpen web dashboard → Settings → "Link Telegram" to get a code, then send /link <code> here.';

const WEB_URL = (process.env.APP_WEB_URL ?? 'https://app.qwai.io').replace(/\/$/, '');

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
    private readonly moduleRef: ModuleRef,
  ) {}

  private getTokenAnalysis(): TokenAnalysisService | null {
    try {
      return this.moduleRef.get(TokenAnalysisService, { strict: false });
    } catch {
      return null;
    }
  }

  get bot(): Bot | null { return this._bot; }
  isEnabled(): boolean  { return !!this._bot; }

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

    /* ── /start ────────────────────────────────────────────────────────────── */
    bot.command('start', (ctx) =>
      ctx.reply(
        [
          '🔥 <b>QWAI Token Scanner</b>',
          '',
          'Paste any Solana or EVM token address to get instant analysis:',
          '• Price, liquidity, volume',
          '• Safety checks (honeypot, taxes, mint authority, LP lock)',
          '• Bundle launch detection',
          '• Smart money wallet signals',
          '• AI verdict + score (when cached)',
          '',
          'Full report with entry price, stop-loss, and targets:',
          `<a href="${WEB_URL}">${WEB_URL.replace('https://', '')}</a>`,
          '',
          '<b>Commands:</b>',
          '/scan &lt;address&gt; — analyze a token',
          '/link &lt;code&gt; — connect your web account (for trading features)',
          '/portfolio — your portfolio (requires /link)',
          '/buy /sell — trade (requires /link)',
          '/snipe — sniper bot commands',
        ].join('\n'),
        {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: new InlineKeyboard()
            .url('🔍 Open Scanner', WEB_URL)
            .text('📊 Portfolio', 'action:portfolio')
            .row()
            .text('🔔 Alerts', 'action:alerts')
            .text('🛑 Kill switch', 'action:kill'),
        },
      ),
    );

    /* ── /link ─────────────────────────────────────────────────────────────── */
    bot.command('link', async (ctx) => {
      const code = ctx.match?.trim();
      if (!code) {
        return ctx.reply(
          'Usage: <code>/link &lt;code&gt;</code>\n\nGenerate from web dashboard → Settings → Link Telegram.',
          { parse_mode: 'HTML' },
        );
      }
      try {
        await this.tgLink.link(String(ctx.chat.id), code);
        return ctx.reply('✅ <b>Linked!</b> Your Telegram and web dashboard now share memory, wallets, and agents.', { parse_mode: 'HTML' });
      } catch (e: any) {
        return ctx.reply(`❌ Link failed: ${e?.message ?? 'unknown error'}`);
      }
    });

    /* ── /scan ─────────────────────────────────────────────────────────────── */
    bot.command('scan', async (ctx) => {
      const parts = (ctx.message?.text ?? '').split(/\s+/);
      const address = parts[1]?.trim();
      if (!address) {
        return ctx.reply(
          '📋 <b>Usage:</b> <code>/scan &lt;address&gt;</code>\n\nOr just paste a contract address directly — I\'ll detect it automatically.',
          { parse_mode: 'HTML' },
        );
      }
      return this.runScan(ctx, address);
    });

    /* ── /portfolio ────────────────────────────────────────────────────────── */
    bot.command('portfolio', async (ctx) => {
      try {
        return ctx.reply(await this.chat(ctx.chat.id, 'Give me my portfolio summary with current positions and P&L.'));
      } catch (e: any) { return ctx.reply(`Error: ${e.message}`); }
    });

    /* ── /buy /sell ────────────────────────────────────────────────────────── */
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
      } catch (e: any) { return ctx.reply(`Error: ${e.message}`); }
    });

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
      } catch (e: any) { return ctx.reply(`Error: ${e.message}`); }
    });

    /* ── /dca /alerts /kill /paper ─────────────────────────────────────────── */
    bot.command('dca', async (ctx) => {
      const args = ctx.match?.trim();
      if (!args) return ctx.reply('Usage: /dca 50 SOL daily');
      try {
        return ctx.reply(await this.chat(ctx.chat.id, `Set up a DCA: buy ${args}`));
      } catch (e: any) { return ctx.reply(`Error: ${e.message}`); }
    });

    bot.command('alerts', async (ctx) => {
      try {
        return ctx.reply(await this.chat(ctx.chat.id, 'Show me my recent alerts and notifications.'));
      } catch (e: any) { return ctx.reply(`Error: ${e.message}`); }
    });

    bot.command('kill', async (ctx) =>
      ctx.reply('🚨 Are you sure you want to engage the kill switch? This pauses ALL agents.', {
        reply_markup: new InlineKeyboard()
          .text('🛑 Yes, kill all', 'confirm:kill')
          .text('Cancel', 'confirm:cancel'),
      }),
    );

    bot.command('paper', async (ctx) =>
      ctx.reply('Paper mode can be toggled in the web dashboard under Settings. Both Telegram and web share the same mode.'),
    );

    /* ── /snipe commands ───────────────────────────────────────────────────── */
    bot.command('snipe', async (ctx) => {
      const userId = await this.resolveUserId(ctx.chat.id);
      if (!userId) return ctx.reply(NOT_LINKED_TEXT);
      const config = await this.prisma.snipeConfig.findUnique({ where: { userId } });
      const lines = [
        '⚡ <b>Sniper Bot</b>',
        '',
        config
          ? [
              `Status: ${config.enabled ? '🟢 Enabled' : '🔴 Disabled'}`,
              `Chain: ${config.chain}`,
              `Buy amount: ${(Number(config.buyAmountRaw) / 1e9).toFixed(4)} SOL`,
              `Slippage: ${(config.maxSlippageBps / 100).toFixed(0)}%`,
              `Groups: ${config.groupIds.length} monitored`,
            ].join('\n')
          : 'No config yet. Set via REST API POST /api/snipe/config',
        '',
        'Commands: /snipe_on  /snipe_off  /snipe_status',
      ];
      return ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
    });

    bot.command('snipe_on', async (ctx) => {
      const userId = await this.resolveUserId(ctx.chat.id);
      if (!userId) return ctx.reply(NOT_LINKED_TEXT);
      try {
        const config = await this.prisma.snipeConfig.findUnique({ where: { userId } });
        if (!config) return ctx.reply('No snipe config found. Configure at /api/snipe/config first.');
        await this.prisma.snipeConfig.update({ where: { userId }, data: { enabled: true } });
        return ctx.reply('✅ Sniper enabled. Add this bot to your groups with privacy mode OFF in BotFather.');
      } catch (e: any) { return ctx.reply(`Error: ${e.message}`); }
    });

    bot.command('snipe_off', async (ctx) => {
      const userId = await this.resolveUserId(ctx.chat.id);
      if (!userId) return ctx.reply(NOT_LINKED_TEXT);
      try {
        await this.prisma.snipeConfig.updateMany({ where: { userId }, data: { enabled: false } });
        this.snipeGroup?.stopUserSession(userId);
        return ctx.reply('🔴 Sniper disabled.');
      } catch (e: any) { return ctx.reply(`Error: ${e.message}`); }
    });

    bot.command('snipe_status', async (ctx) => {
      const userId = await this.resolveUserId(ctx.chat.id);
      if (!userId) return ctx.reply(NOT_LINKED_TEXT);
      const status = this.snipeGroup ? this.snipeGroup.getUserSessionStatus(userId) : { active: false };
      const config = await this.prisma.snipeConfig.findUnique({ where: { userId } });
      return ctx.reply([
        `Session: ${status.active ? `🟢 Active` : '🔴 Inactive'}`,
        `Sniper: ${config?.enabled ? '🟢 Enabled' : '🔴 Disabled'}`,
        `Groups: ${config?.groupIds?.join(', ') || 'none'}`,
      ].join('\n'));
    });

    /* ── Inline callbacks ──────────────────────────────────────────────────── */
    bot.callbackQuery(/^action:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const action = ctx.match[1];
      switch (action) {
        case 'portfolio': return ctx.reply(await this.chat(ctx.chat!.id, 'Portfolio summary'));
        case 'alerts':    return ctx.reply(await this.chat(ctx.chat!.id, 'Show my recent alerts'));
        case 'kill':      return ctx.reply('Use /kill to engage the kill switch.');
        case 'paper':     return ctx.reply('Toggle paper mode in the web Settings page.');
        default:          return ctx.reply(`Unknown action: ${action}`);
      }
    });

    bot.callbackQuery(/^confirm:kill$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      try {
        return ctx.reply(await this.chat(ctx.chat!.id, 'Engage kill switch immediately. Pause all agents.'));
      } catch (e: any) { return ctx.reply(`Error: ${e.message}`); }
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
      } catch (e: any) { return ctx.reply(`Error: ${e.message}`); }
    });

    bot.callbackQuery(/^approve:([\w-]+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const [, requestId] = ctx.match;
      const userId = await this.resolveUserId(ctx.chat!.id);
      if (!userId) return ctx.reply(NOT_LINKED_TEXT);
      try {
        await this.approvals.respond(userId, requestId, true, ApprovalChannel.TELEGRAM);
        return ctx.reply('✅ Approved. Executing.');
      } catch (e: any) { return ctx.reply(`Error: ${e.message}`); }
    });

    bot.callbackQuery(/^reject:([\w-]+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const [, requestId] = ctx.match;
      const keyboard = new InlineKeyboard()
        .text('Too risky',   `reject_reason:${requestId}:TOO_RISKY`)
        .text('Wrong token', `reject_reason:${requestId}:WRONG_TOKEN`)
        .row()
        .text('Bad timing',  `reject_reason:${requestId}:BAD_TIMING`)
        .text('Wrong size',  `reject_reason:${requestId}:WRONG_SIZE`)
        .row()
        .text('Other',       `reject_reason:${requestId}:OTHER`);
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
      } catch (e: any) { return ctx.reply(`Error: ${e.message}`); }
    });

    bot.callbackQuery(/^snooze:(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery('Snoozed');
      return ctx.reply('🔕 Alert snoozed.');
    });

    /* ── Rescan callback (inline button on scan results) ───────────────────── */
    bot.callbackQuery(/^rescan:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery('Rescanning…');
      return this.runScan(ctx, ctx.match[1], true);
    });

    /* ── Channel posts → sniper hot path ───────────────────────────────────── */
    bot.on('channel_post:text', async (ctx) => {
      if (!this.snipeGroup) return;
      const groupId = String(ctx.chat.id);
      this.snipeGroup.handleGroupMessage(groupId, ctx.channelPost.text ?? '')
        .catch(e => this.logger.error(`snipeGroup channel_post: ${e.message}`));
    });

    /* ── Catch-all message handler ─────────────────────────────────────────── */
    bot.on('message:text', async (ctx) => {
      const chatType = ctx.chat.type;
      const text = (ctx.message.text ?? '').trim();

      // Groups: sniper hot path (no unsolicited replies unless /scan used)
      if ((chatType === 'group' || chatType === 'supergroup') && this.snipeGroup) {
        const groupId = String(ctx.chat.id);
        this.snipeGroup.handleGroupMessage(groupId, text)
          .catch(e => this.logger.error(`snipeGroup message: ${e.message}`));
        return;
      }

      // Skip explicit commands (handled above)
      if (text.startsWith('/')) return;

      // Private chat: auto-detect CA → scan
      if (detectChain(text)) return this.runScan(ctx, text);

      // Everything else → AI agent
      try {
        return ctx.reply(await this.chat(ctx.chat.id, text));
      } catch (e: any) {
        return ctx.reply('Error talking to QWAI: ' + e.message);
      }
    });
  }

  /* ── Core scan implementation ────────────────────────────────────────────── */
  private async runScan(ctx: any, address: string, force = false): Promise<void> {
    const chain = detectChain(address);
    if (!chain) {
      await ctx.reply(
        '❌ <b>Unrecognized address format.</b>\n\nPaste a Solana (base58) or EVM (0x…) token address.',
        { parse_mode: 'HTML' },
      );
      return;
    }

    const svc = this.getTokenAnalysis();
    if (!svc) {
      await ctx.reply('Token analysis service unavailable.');
      return;
    }

    // 1. Send placeholder immediately so user gets instant feedback
    let placeholderMsgId: number | undefined;
    try {
      const msg = await ctx.reply(formatPlaceholder(address), { parse_mode: 'HTML' });
      placeholderMsgId = msg.message_id;
    } catch {
      // If placeholder fails, we'll send a new message later
    }

    const editOrReply = async (text: string, opts: Record<string, any>) => {
      if (placeholderMsgId) {
        try {
          return await ctx.api.editMessageText(ctx.chat.id, placeholderMsgId, text, opts);
        } catch {
          // Fall back to new message if edit fails (e.g. message too old)
        }
      }
      return ctx.reply(text, opts);
    };

    try {
      // 2. Run full analysis (in-memory + DB cache → instant if warm; pipeline if cold)
      const report = await svc.analyzeAddress(address, force);

      const result = report.kill?.triggered
        ? formatKillReport(report, address, WEB_URL)
        : formatScanReport(report, address, WEB_URL);

      // Add rescan button
      result.keyboard.row().text('🔄 Rescan', `rescan:${address}`);

      await editOrReply(result.text, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: result.keyboard,
      });

      // 3. Background: pre-warm meme_hunter profile so website link loads instantly
      if (!force) {
        svc.analyzeWithProfile(address, 'meme_hunter', 'alpha', false, null)
          .catch(() => {});
      }

    } catch (e: any) {
      this.logger.warn(`/scan failed for ${address}: ${e.message}`);
      const errText = [
        `❌ <b>Analysis failed</b>`,
        `<code>${address.slice(0, 20)}…</code>`,
        '',
        `<i>${e.message.slice(0, 200)}</i>`,
        '',
        'Try again with /scan or check the address is correct.',
      ].join('\n');

      await editOrReply(errText, { parse_mode: 'HTML' }).catch(() => {});
    }
  }
}
