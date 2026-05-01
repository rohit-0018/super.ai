import { forwardRef, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Bot, InlineKeyboard } from 'grammy';
import { ApprovalChannel, RejectCategory } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AiAgentService } from '../ai-agent/ai-agent.service';
import { LlmService, ChatMessage } from '../ai-agent/llm.service';
import { TelegramLinkService } from '../auth/telegram-link.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { SnipeGroupService } from '../snipe/snipe-group.service';
import { HotTokensService } from '../hot-tokens/hot-tokens.service';
import { detectChain } from '../token-analysis/chain-detector';
import { TokenAnalysisService } from '../token-analysis/token-analysis.service';
import {
  formatScanReport,
  formatKillReport,
  formatPlaceholder,
} from './telegram-scan.formatter';

const NOT_LINKED_TEXT =
  '🔗 Account not linked. Send /login for a one-tap connect link.';

const LOGIN_CTA_TEXT =
  '\n\n🔗 <i>Link your QWAI account to unlock trading, portfolio, and personalized signals.</i>\nTap /login to connect.';

const WEB_URL = (process.env.APP_WEB_URL ?? 'https://app.qwai.io').replace(/\/$/, '');

interface GuestSession {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  lastAt: number;
}

@Injectable()
export class TelegramBot {
  private readonly logger = new Logger(TelegramBot.name);
  private _bot: Bot | null = null;

  // Guest (unlinked) conversation history — 15-min TTL, max 8 messages per session
  private guestSessions = new Map<string, GuestSession>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly agent: AiAgentService,
    private readonly llm: LlmService,
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

  private getHotTokens(): HotTokensService | null {
    try {
      return this.moduleRef.get(HotTokensService, { strict: false });
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
    if (!userId) {
      return `❌ This command requires a linked QWAI account.\n\n/login to connect in one tap.`;
    }
    const reply = await this.agent.chat(userId, content, 'telegram');
    return reply ?? '…';
  }

  private async guestChat(chatId: string, message: string): Promise<string> {
    if (!this.llm.isConfigured) return '❌ AI is not configured.';

    // Build hot tokens context
    let hotContext = '';
    try {
      const svc = this.getHotTokens();
      if (svc) {
        const tokens = svc.getHotTokensForAgent('meme_hunter');
        if (tokens) hotContext = `\n\n<b>Live hot tokens right now:</b>\n${tokens}`;
      }
    } catch { /* */ }

    const systemPrompt = [
      'You are QWAI, an expert AI crypto trading assistant.',
      '',
      'WHAT YOU CAN DO:',
      '- Answer questions about any crypto token, DeFi protocol, or market trend',
      '- Explain concepts like rug pulls, bundle launches, honeypots, bonding curves, liquidity',
      '- List hot/trending tokens from the live scan data provided',
      '- Discuss general market conditions and sentiment',
      '- When user pastes a token address, tell them to paste it directly in the chat for an automatic scan',
      '',
      'WHAT YOU CANNOT DO (requires linked QWAI account):',
      '- Access portfolio, wallet balances, trade history',
      '- Execute trades (buy/sell)',
      '- Set up agents, DCA, or alerts',
      '- If asked for these, say: "This requires a linked account. Use /login to connect in one tap."',
      '',
      'FORMATTING (Telegram HTML parse_mode — strict rules):',
      '- Use <b>text</b> for important values and headers',
      '- Use <i>text</i> for notes and context',
      '- Use <code>text</code> for addresses, symbols, and numbers',
      '- Separate sections with a blank line',
      '- Never use markdown (no ** or ##)',
      '- Max ~600 chars per response. Be dense and insightful.',
      '- Lead with the key insight. Put context after.',
      '',
      hotContext,
    ].join('\n');

    const now = Date.now();
    const SESSION_TTL = 15 * 60_000;
    let session = this.guestSessions.get(chatId);
    if (!session || now - session.lastAt > SESSION_TTL) {
      session = { messages: [], lastAt: now };
      this.guestSessions.set(chatId, session);
    }
    session.lastAt = now;

    session.messages.push({ role: 'user', content: message });
    if (session.messages.length > 8) session.messages.splice(0, session.messages.length - 8);

    const msgs: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...session.messages,
    ];

    const reply = await this.llm.chat(msgs, 600);
    session.messages.push({ role: 'assistant', content: reply });

    // Prune old sessions every 50 calls to avoid unbounded growth
    if (this.guestSessions.size > 1000) {
      const cutoff = Date.now() - SESSION_TTL;
      for (const [id, s] of this.guestSessions) {
        if (s.lastAt < cutoff) this.guestSessions.delete(id);
      }
    }

    return reply + LOGIN_CTA_TEXT;
  }

  private registerHandlers(bot: Bot) {

    /* ── /start ────────────────────────────────────────────────────────────── */
    bot.command('start', (ctx) =>
      ctx.reply(
        [
          '🔥 <b>QWAI — AI Crypto Scanner</b>',
          '',
          'Paste any Solana or EVM token address for instant analysis:',
          '• Price · liquidity · volume · safety',
          '• Bundle launch detection · smart money signals',
          '• AI verdict + trading strategy',
          '',
          'Ask me anything: <i>"show hot tokens"</i>, <i>"explain rug pull"</i>, <i>"best memecoins today"</i>',
          '',
          '<b>Commands:</b>',
          '/scan &lt;address&gt; — deep-scan a token',
          '/login — link your QWAI account (1-tap)',
          '/portfolio — your positions &amp; P&amp;L (linked only)',
          '/buy /sell — trade (linked only)',
          '/snipe — sniper bot',
        ].join('\n'),
        {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: new InlineKeyboard()
            .url('🌐 Open QWAI', WEB_URL)
            .text('🔗 Link Account', 'action:login')
            .row()
            .text('🔥 Hot Tokens', 'action:hot')
            .text('📊 Portfolio', 'action:portfolio'),
        },
      ),
    );

    /* ── /login (TG→Web magic link) ───────────────────────────────────────── */
    bot.command('login', async (ctx) => {
      const userId = await this.resolveUserId(ctx.chat.id);
      if (userId) {
        return ctx.reply(
          '✅ <b>Already linked!</b> Your Telegram and QWAI account are connected.\n\nUse /portfolio, /buy, /sell and all trading commands.',
          { parse_mode: 'HTML' },
        );
      }
      const { token, expiresAt } = this.tgLink.issueMagicToken(String(ctx.chat.id));
      const url = `${WEB_URL}/auth/telegram?token=${token}`;
      const mins = Math.round((expiresAt.getTime() - Date.now()) / 60_000);
      return ctx.reply(
        [
          '🔗 <b>Connect your QWAI account</b>',
          '',
          'Tap the button below — you\'ll be taken to QWAI where you can connect your wallet.',
          `<i>Link expires in ${mins} minutes.</i>`,
          '',
          `<a href="${url}">${url}</a>`,
        ].join('\n'),
        {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: new InlineKeyboard().url('🔗 Connect Account →', url),
        },
      );
    });

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
      const chatId = ctx.chat!.id;
      switch (action) {
        case 'login': {
          const userId = await this.resolveUserId(chatId);
          if (userId) return ctx.reply('✅ Already linked! Use /portfolio, /buy, /sell.', { parse_mode: 'HTML' });
          const { token, expiresAt } = this.tgLink.issueMagicToken(String(chatId));
          const url = `${WEB_URL}/auth/telegram?token=${token}`;
          const mins = Math.round((expiresAt.getTime() - Date.now()) / 60_000);
          return ctx.reply(
            `🔗 <b>Connect QWAI Account</b>\n\nExpires in ${mins} min.\n<a href="${url}">Tap to connect →</a>`,
            { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: new InlineKeyboard().url('🔗 Connect →', url) },
          );
        }
        case 'hot': {
          const userId = await this.resolveUserId(chatId);
          if (userId) return ctx.reply(await this.chat(chatId, 'Show me the top hot tokens right now'));
          return ctx.reply(await this.guestChat(String(chatId), 'Show me the top hot tokens right now'));
        }
        case 'portfolio': return ctx.reply(await this.chat(chatId, 'Portfolio summary'));
        case 'alerts':    return ctx.reply(await this.chat(chatId, 'Show my recent alerts'));
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

      // Hot tokens shortcut — bypass LLM, format directly
      if (this.isHotTokensQuery(text)) {
        return this.runHotTokens(ctx);
      }

      // Everything else → AI with loading indicator
      return this.runChat(ctx, text);
    });
  }

  /* ── Hot-tokens direct formatter (no LLM) ───────────────────────────────── */
  private isHotTokensQuery(text: string): boolean {
    return /hot\s*tokens?|trending\s*(tokens?|coins?)|top\s*\d*\s*(tokens?|coins?)|what.*(hot|trending|pumping|mooning)|show.*tokens?|list.*tokens?|best\s*(tokens?|coins?)\s*today|pump|gem/i.test(text);
  }

  private async runHotTokens(ctx: any): Promise<void> {
    // Send placeholder immediately
    let msgId: number | undefined;
    try {
      const m = await ctx.reply('🔥 <b>Fetching hot tokens…</b>', { parse_mode: 'HTML' });
      msgId = m.message_id;
    } catch { /* */ }

    const editOrReply = async (text: string, opts: Record<string, any>) => {
      if (msgId) {
        try { return await ctx.api.editMessageText(ctx.chat.id, msgId, text, opts); } catch { /* */ }
      }
      return ctx.reply(text, opts);
    };

    const svc = this.getHotTokens();
    const scan = svc?.getLatest('meme_hunter');

    if (!scan || !scan.tokens.length) {
      await editOrReply(
        '📡 <b>Hot tokens scanner is warming up.</b>\n\n<i>First scan runs on startup — check back in a minute.</i>',
        { parse_mode: 'HTML' },
      );
      return;
    }

    const tokens = scan.tokens.slice(0, 10);
    const ageMin = Math.round((Date.now() - new Date(scan.scannedAt).getTime()) / 60_000);
    const ageStr = ageMin < 1 ? 'just now' : `${ageMin}m ago`;

    const lines: string[] = [
      `🔥 <b>Hot Tokens — Meme Hunter</b>  <i>· ${ageStr}</i>`,
      '',
    ];

    const VERDICT_ICON: Record<string, string> = {
      STRONG_BUY: '🚀', BUY: '📈', CAUTIOUS: '⚠️', SKIP: '⏭', HIGH_RISK: '🚨',
    };

    tokens.forEach((t, i) => {
      const icon    = VERDICT_ICON[t.verdict] ?? '•';
      const price   = t.priceUsd < 0.0001
        ? `$${t.priceUsd.toExponential(2)}`
        : t.priceUsd < 1
        ? `$${t.priceUsd.toFixed(6)}`
        : `$${t.priceUsd.toFixed(4)}`;
      const ch1h    = `${t.priceChange1h >= 0 ? '+' : ''}${t.priceChange1h.toFixed(1)}%`;
      const ch24h   = `${t.priceChange24h >= 0 ? '+' : ''}${t.priceChange24h.toFixed(1)}%`;
      const mcap    = fmtUsd(t.marketCapUsd);
      const vol     = fmtUsd(t.volume24hUsd);

      lines.push(`${i + 1}. ${icon} <b>${esc(t.symbol)}</b>  ·  ${esc(price)}`);
      lines.push(`   <code>${t.address.slice(0, 8)}…${t.address.slice(-4)}</code>  ·  Score <b>${t.score}/100</b>`);
      lines.push(`   ${ch1h} 1h  ·  ${ch24h} 24h  ·  MCap ${mcap}  ·  Vol ${vol}`);
      if (t.summary) lines.push(`   <i>${esc(t.summary.slice(0, 80))}</i>`);
      lines.push('');
    });

    lines.push(`<a href="${WEB_URL}/intel">🔍 Full deep-scan on any token →</a>`);

    const keyboard = new InlineKeyboard()
      .text('🔄 Refresh', 'action:hot')
      .url('🌐 Open QWAI', WEB_URL)
      .row()
      .text('🔗 Link Account', 'action:login');

    await editOrReply(lines.join('\n'), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: keyboard,
    });
  }

  /* ── General chat with loading indicator ────────────────────────────────── */
  private async runChat(ctx: any, text: string): Promise<void> {
    // Send thinking placeholder immediately
    let msgId: number | undefined;
    try {
      const m = await ctx.reply(
        '⏳ <i>Thinking…</i>',
        { parse_mode: 'HTML' },
      );
      msgId = m.message_id;
    } catch { /* */ }

    const editOrReply = async (replyText: string, opts: Record<string, any>) => {
      if (msgId) {
        try { return await ctx.api.editMessageText(ctx.chat.id, msgId, replyText, opts); } catch { /* */ }
      }
      return ctx.reply(replyText, opts);
    };

    const userId = await this.resolveUserId(ctx.chat.id);

    try {
      if (userId) {
        // Linked user → full agent with all tools
        const reply = await this.agent.chat(userId, text, 'telegram');
        await editOrReply(reply ?? '…', {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        });
      } else {
        // Guest → read-only AI
        const reply = await this.guestChat(String(ctx.chat.id), text);
        await editOrReply(reply, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: new InlineKeyboard()
            .text('🔗 Link Account', 'action:login')
            .url('🌐 Open QWAI', WEB_URL),
        });
      }
    } catch (e: any) {
      await editOrReply(`❌ <i>${esc(e.message?.slice(0, 200) ?? 'Something went wrong')}</i>`, {
        parse_mode: 'HTML',
      }).catch(() => {});
    }
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
        link_preview_options: { is_disabled: true },
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

/* ── Module-level helpers ────────────────────────────────────────────────── */

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtUsd(v: number): string {
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(1)}B`;
  if (v >= 1_000_000)     return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)         return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}
