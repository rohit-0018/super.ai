import { forwardRef, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Bot, InlineKeyboard, InputFile } from 'grammy';
import { AgentKind, AgentStatus, ApprovalChannel, RejectCategory, TradeMode } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AiAgentService } from '../ai-agent/ai-agent.service';
import { LlmService, ChatMessage } from '../ai-agent/llm.service';
import { TelegramLinkService } from '../auth/telegram-link.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { SnipeGroupService } from '../snipe/snipe-group.service';
import { HotTokensService } from '../hot-tokens/hot-tokens.service';
import { SignalPipelineService } from '../hot-tokens/signal-pipeline.service';
import { detectChain } from '../token-analysis/chain-detector';
import { fmtPriceUsd } from '../common/format-price';
import { TokenAnalysisService } from '../token-analysis/token-analysis.service';
import { PumpFunProvider, PumpFunCoinData } from '../token-analysis/providers/pump-fun.provider';
import { isPumpFunMint } from '../token-analysis/providers/pump-fun.util';
import {
  formatScanReport,
  formatKillReport,
  formatPlaceholder,
} from './telegram-scan.formatter';
import { fetchOhlcv, RateLimitedError, generateCandleChart, generateDexChart, buildChartCaption, gtNetwork } from './telegram-chart';

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
  // In-memory reminder timers — chatId:ts → timeout handle
  private reminders = new Map<string, ReturnType<typeof setTimeout>>();

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

  private getPumpFun(): PumpFunProvider | null {
    try {
      return this.moduleRef.get(PumpFunProvider, { strict: false });
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

  private getSignalPipeline(): SignalPipelineService | null {
    try {
      return this.moduleRef.get(SignalPipelineService, { strict: false });
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
    // Register command list with Telegram so the autocomplete menu works
    bot.api.setMyCommands(BOT_COMMANDS).catch((e) =>
      this.logger.warn(`setMyCommands failed: ${e?.message}`),
    );
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
        if (tokens) hotContext = `\n\nLIVE HOT TOKENS RIGHT NOW (use this data when the user asks about hot or trending tokens — format your reply with HTML tags):\n${tokens}`;
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

    /* ── 1. /start ──────────────────────────────────────────────────────────── */
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
          '/top — hot tokens right now',
          '/login — link your QWAI account (1-tap)',
          '/portfolio — your positions &amp; P&amp;L (linked)',
          '/buy /sell — execute trades (linked)',
          '/dca — dollar-cost average bot (linked)',
          '/alerts — recent alerts (linked)',
          '/kill — emergency stop all agents (linked)',
          '/paper — toggle paper trading mode (linked)',
          '/snipe — sniper bot (linked)',
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

    /* ── 2. /login (TG→Web magic link) ─────────────────────────────────────── */
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

    /* ── 3. /link ───────────────────────────────────────────────────────────── */
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

    /* ── 4. /scan ───────────────────────────────────────────────────────────── */
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

    /* ── 5. /top / /top10 — fast-lane hot tokens, no LLM ───────────────────── */
    bot.command('top', async (ctx) => this.runHotTokens(ctx));
    bot.command('top10', async (ctx) => this.runHotTokens(ctx));

    /* ── 6. /portfolio ──────────────────────────────────────────────────────── */
    bot.command('portfolio', async (ctx) => {
      const userId = await this.resolveUserId(ctx.chat.id);
      if (!userId) return ctx.reply(NOT_LINKED_TEXT);
      return this.replyPortfolio(ctx, userId);
    });

    /* ── 7. /buy ────────────────────────────────────────────────────────────── */
    bot.command('buy', async (ctx) => {
      const userId = await this.resolveUserId(ctx.chat.id);
      if (!userId) return ctx.reply(NOT_LINKED_TEXT);

      const args = ctx.match?.trim();
      if (!args) {
        return ctx.reply(
          [
            '📋 <b>Buy Usage:</b>',
            '<code>/buy &lt;amount&gt; SOL &lt;token_address&gt;</code>',
            '<code>/buy &lt;amount&gt; USDC &lt;token_address&gt;</code>',
            '',
            '<b>Examples:</b>',
            '<code>/buy 0.5 SOL HfMbF9X...F5p</code>',
            '<code>/buy 100 USDC 0x123...abc</code>',
            '',
            '<i>Paste a token address first for a /scan to see safety details before buying.</i>',
          ].join('\n'),
          { parse_mode: 'HTML' },
        );
      }

      try {
        const loadMsg = await ctx.reply('⏳ <i>Preparing order preview…</i>', { parse_mode: 'HTML' });
        const reply = await this.agent.chat(
          userId,
          `I want to buy ${args}. Show me the order preview with token details, estimated price impact, and fees. Do NOT execute the trade yet — just show me the details so I can confirm.`,
          'telegram',
        );
        try {
          await ctx.api.deleteMessage(ctx.chat.id, loadMsg.message_id);
        } catch { /* */ }
        return ctx.reply(reply ?? '…', {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: new InlineKeyboard()
            .text('✅ Confirm Buy', `confirm:buy:${args}`)
            .text('❌ Cancel', 'confirm:cancel'),
        });
      } catch (e: any) { return ctx.reply(`❌ Error: ${e.message}`); }
    });

    /* ── 8. /sell ───────────────────────────────────────────────────────────── */
    bot.command('sell', async (ctx) => {
      const userId = await this.resolveUserId(ctx.chat.id);
      if (!userId) return ctx.reply(NOT_LINKED_TEXT);

      const args = ctx.match?.trim();
      if (!args) {
        return ctx.reply(
          [
            '📋 <b>Sell Usage:</b>',
            '<code>/sell &lt;amount&gt; SOL</code>',
            '<code>/sell &lt;amount&gt; &lt;token_address&gt;</code>',
            '<code>/sell 50% &lt;token_address&gt;</code>',
            '',
            '<b>Examples:</b>',
            '<code>/sell 1 SOL</code>',
            '<code>/sell 50% HfMbF9X...F5p</code>',
            '<code>/sell all HfMbF9X...F5p</code>',
          ].join('\n'),
          { parse_mode: 'HTML' },
        );
      }

      try {
        const loadMsg = await ctx.reply('⏳ <i>Preparing sell preview…</i>', { parse_mode: 'HTML' });
        const reply = await this.agent.chat(
          userId,
          `I want to sell ${args}. Show me the order preview with current price, estimated proceeds, and fees. Do NOT execute yet — just show me the details so I can confirm.`,
          'telegram',
        );
        try {
          await ctx.api.deleteMessage(ctx.chat.id, loadMsg.message_id);
        } catch { /* */ }
        return ctx.reply(reply ?? '…', {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: new InlineKeyboard()
            .text('✅ Confirm Sell', `confirm:sell:${args}`)
            .text('❌ Cancel', 'confirm:cancel'),
        });
      } catch (e: any) { return ctx.reply(`❌ Error: ${e.message}`); }
    });

    /* ── 9. /dca ────────────────────────────────────────────────────────────── */
    bot.command('dca', async (ctx) => {
      const userId = await this.resolveUserId(ctx.chat.id);
      if (!userId) return ctx.reply(NOT_LINKED_TEXT);

      const args = ctx.match?.trim();

      // No args → list existing DCAs
      if (!args) {
        try {
          const dcas = await this.prisma.agent.findMany({
            where: { userId, kind: AgentKind.DCA },
            orderBy: { createdAt: 'desc' },
          });
          if (dcas.length === 0) {
            return ctx.reply(
              [
                '⏱ <b>DCA Bot</b>',
                '',
                'No active DCA orders.',
                '',
                '<b>Create one:</b>',
                '<code>/dca &lt;amount_usd&gt; &lt;token_address&gt; &lt;interval&gt;</code>',
                '',
                'Intervals: <code>hourly</code> | <code>daily</code> | <code>weekly</code> | <code>monthly</code>',
                '',
                '<b>Example:</b>',
                '<code>/dca 50 HfMbF9X...F5p daily</code>',
              ].join('\n'),
              { parse_mode: 'HTML' },
            );
          }
          const lines = ['⏱ <b>DCA Orders</b>', ''];
          for (const d of dcas) {
            const p = d.params as any;
            const addr = (p.tokenOut ?? 'unknown') as string;
            const statusIcon = d.status === AgentStatus.RUNNING ? '🟢' : '🔴';
            lines.push(`${statusIcon} <b>$${p.amountUsd}</b> → <code>${addr.slice(0, 8)}…${addr.slice(-4)}</code>  every <b>${p.interval}</b>`);
            lines.push(`   Created ${timeAgo(d.createdAt)}`);
          }
          lines.push('');
          lines.push('<i>/dca &lt;amount&gt; &lt;address&gt; &lt;interval&gt; to add more</i>');
          return ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
        } catch (e: any) { return ctx.reply(`❌ Error: ${e.message}`); }
      }

      // Parse: /dca <amount_usd> <token_address> <interval>
      const parts = args.split(/\s+/);
      if (parts.length < 3) {
        return ctx.reply(
          'Usage: <code>/dca &lt;amount_usd&gt; &lt;token_address&gt; &lt;interval&gt;</code>\nExample: <code>/dca 50 HfMbF9X...F5p daily</code>',
          { parse_mode: 'HTML' },
        );
      }

      const amountUsd = parseFloat(parts[0]);
      const tokenAddress = parts[1];
      const intervalStr = parts[2]?.toLowerCase();
      const VALID_INTERVALS = ['hourly', 'daily', 'weekly', 'monthly'];

      if (isNaN(amountUsd) || amountUsd <= 0) {
        return ctx.reply('❌ Invalid amount. Use a number like <code>50</code>', { parse_mode: 'HTML' });
      }
      if (!VALID_INTERVALS.includes(intervalStr)) {
        return ctx.reply(`❌ Invalid interval. Use: ${VALID_INTERVALS.join(' | ')}`);
      }
      const chain = detectChain(tokenAddress);
      if (!chain) {
        return ctx.reply('❌ Invalid token address. Paste a Solana (base58) or EVM (0x…) address.');
      }

      try {
        const wallet = await this.prisma.wallet.findFirst({ where: { userId, isPrimary: true } })
          ?? await this.prisma.wallet.findFirst({ where: { userId } });
        if (!wallet) {
          return ctx.reply('❌ No wallet found. Create one at the QWAI dashboard first.\n\n' + WEB_URL + '/wallets');
        }

        await this.prisma.agent.create({
          data: {
            userId,
            kind: AgentKind.DCA,
            status: AgentStatus.RUNNING,
            params: {
              walletId: wallet.id,
              tokenIn: chain === 'SOLANA' ? 'SOL' : 'ETH',
              tokenOut: tokenAddress,
              amountUsd,
              interval: intervalStr,
              chain,
            },
          },
        });

        return ctx.reply(
          [
            '✅ <b>DCA Created</b>',
            '',
            `Buying <b>$${amountUsd}</b> of <code>${tokenAddress.slice(0, 8)}…${tokenAddress.slice(-6)}</code>`,
            `Every: <b>${intervalStr}</b>`,
            `Wallet: <code>${wallet.address.slice(0, 8)}…${wallet.address.slice(-6)}</code>`,
            `Chain: <b>${chain}</b>`,
            '',
            '<i>View all orders with /dca · Stop via the web dashboard.</i>',
          ].join('\n'),
          { parse_mode: 'HTML' },
        );
      } catch (e: any) { return ctx.reply(`❌ Error: ${e.message}`); }
    });

    /* ── 10. /alerts ────────────────────────────────────────────────────────── */
    bot.command('alerts', async (ctx) => {
      const userId = await this.resolveUserId(ctx.chat.id);
      if (!userId) return ctx.reply(NOT_LINKED_TEXT);
      return this.replyAlerts(ctx, userId);
    });

    /* ── 11. /kill ──────────────────────────────────────────────────────────── */
    bot.command('kill', async (ctx) => {
      const userId = await this.resolveUserId(ctx.chat.id);
      if (!userId) return ctx.reply(NOT_LINKED_TEXT);

      // Show current status
      const cfg = await this.prisma.guardrailConfig.findUnique({ where: { userId } });
      const already = cfg?.killSwitch ?? false;

      if (already) {
        return ctx.reply(
          [
            '🛑 <b>Kill Switch is already ON</b>',
            '',
            'All trading is currently paused.',
            '<i>Re-enable from the web dashboard → Settings → Guardrails.</i>',
          ].join('\n'),
          { parse_mode: 'HTML' },
        );
      }

      const runningCount = await this.prisma.agent.count({ where: { userId, status: AgentStatus.RUNNING } });
      return ctx.reply(
        [
          '🚨 <b>Engage Kill Switch?</b>',
          '',
          `This will pause ALL trading and stop <b>${runningCount}</b> running agent(s).`,
          'No new orders will be placed until you re-enable from the dashboard.',
        ].join('\n'),
        {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard()
            .text('🛑 Yes, kill all', 'confirm:kill')
            .text('Cancel', 'confirm:cancel'),
        },
      );
    });

    /* ── 12. /paper ─────────────────────────────────────────────────────────── */
    bot.command('paper', async (ctx) => {
      const userId = await this.resolveUserId(ctx.chat.id);
      if (!userId) return ctx.reply(NOT_LINKED_TEXT);

      try {
        const user = await this.prisma.user.findUnique({
          where: { id: userId },
          select: { paperMode: true },
        });
        const current = user?.paperMode ?? false;
        const newMode = !current;

        await this.prisma.user.update({ where: { id: userId }, data: { paperMode: newMode } });

        if (newMode) {
          // Seed paper balance on first enable
          await this.prisma.paperBalance.upsert({
            where: { userId_token: { userId, token: 'USDC' } },
            update: {},
            create: { userId, token: 'USDC', amount: '10000000000' }, // 10k USDC (6 dec)
          });
          return ctx.reply(
            [
              '📄 <b>Paper Mode ON</b>',
              '',
              'You now have <b>$10,000 virtual USDC</b> to practise trading.',
              'All trades are simulated — no real money at risk.',
              '',
              '<i>Toggle off with /paper again to go live.</i>',
            ].join('\n'),
            { parse_mode: 'HTML' },
          );
        } else {
          return ctx.reply(
            [
              '🔴 <b>Live Mode ON</b>',
              '',
              'Paper trading disabled. Trades now execute with <b>real funds</b>.',
              '',
              '⚠️ <i>Use /kill to emergency-stop all agents if needed.</i>',
            ].join('\n'),
            { parse_mode: 'HTML' },
          );
        }
      } catch (e: any) { return ctx.reply(`❌ Error: ${e.message}`); }
    });

    /* ── 13-15. /snipe commands ─────────────────────────────────────────────── */
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
          : 'No config yet. Configure via web dashboard → Sniper.',
        '',
        'Commands: /snipe_on  /snipe_off  /snipe_status',
      ];
      return ctx.reply(lines.join('\n'), {
        parse_mode: 'HTML',
        reply_markup: config
          ? new InlineKeyboard()
              .text(config.enabled ? '🔴 Disable' : '🟢 Enable', config.enabled ? 'snipe:off' : 'snipe:on')
              .url('⚙️ Configure', `${WEB_URL}/settings`)
          : new InlineKeyboard().url('⚙️ Configure', `${WEB_URL}/settings`),
      });
    });

    /* ── 16. /snipe_on ──────────────────────────────────────────────────────── */
    bot.command('snipe_on', async (ctx) => {
      const userId = await this.resolveUserId(ctx.chat.id);
      if (!userId) return ctx.reply(NOT_LINKED_TEXT);
      try {
        const config = await this.prisma.snipeConfig.findUnique({ where: { userId } });
        if (!config) {
          return ctx.reply(
            '❌ No snipe config found.\n\nConfigure at the web dashboard first: ' + WEB_URL + '/settings',
          );
        }
        await this.prisma.snipeConfig.update({ where: { userId }, data: { enabled: true } });
        return ctx.reply('✅ <b>Sniper enabled.</b>\n\nAdd this bot to your groups with privacy mode OFF in BotFather.', { parse_mode: 'HTML' });
      } catch (e: any) { return ctx.reply(`❌ Error: ${e.message}`); }
    });

    /* ── 17. /snipe_off ─────────────────────────────────────────────────────── */
    bot.command('snipe_off', async (ctx) => {
      const userId = await this.resolveUserId(ctx.chat.id);
      if (!userId) return ctx.reply(NOT_LINKED_TEXT);
      try {
        await this.prisma.snipeConfig.updateMany({ where: { userId }, data: { enabled: false } });
        this.snipeGroup?.stopUserSession(userId);
        return ctx.reply('🔴 <b>Sniper disabled.</b>', { parse_mode: 'HTML' });
      } catch (e: any) { return ctx.reply(`❌ Error: ${e.message}`); }
    });

    /* ── /snipe_status ──────────────────────────────────────────────────────── */
    bot.command('snipe_status', async (ctx) => {
      const userId = await this.resolveUserId(ctx.chat.id);
      if (!userId) return ctx.reply(NOT_LINKED_TEXT);
      const status = this.snipeGroup ? this.snipeGroup.getUserSessionStatus(userId) : { active: false };
      const config = await this.prisma.snipeConfig.findUnique({ where: { userId } });
      return ctx.reply(
        [
          '⚡ <b>Sniper Status</b>',
          '',
          `Session: ${status.active ? '🟢 Active' : '🔴 Inactive'}`,
          `Sniper: ${config?.enabled ? '🟢 Enabled' : '🔴 Disabled'}`,
          `Groups: ${config?.groupIds?.join(', ') || 'none'}`,
        ].join('\n'),
        { parse_mode: 'HTML' },
      );
    });

    /* ════════════════════════════════════════════════════════════════════════
       RICKBOT-STYLE INFORMATIONAL COMMANDS
       ════════════════════════════════════════════════════════════════════════ */

    /* ── 🔍 /z — Quick compact scan ────────────────────────────────────────── */
    bot.command('z', async (ctx) => {
      const addr = ctx.match?.trim().split(/\s+/)[0];
      if (!addr) return ctx.reply('Usage: /z <token_address>  — quick token scan');
      const chain = detectChain(addr);
      if (!chain) return ctx.reply('❌ Invalid address format.');
      const msg = await ctx.reply('⚡ <i>Quick scan…</i>', { parse_mode: 'HTML' });
      try {
        const data = await this.fetchDexPair(addr);
        if (!data) {
          return ctx.api.editMessageText(ctx.chat.id, msg.message_id, '❌ No DEX data found for that address.');
        }
        const ch24 = data.priceChange?.h24 ?? 0;
        const ch1h = data.priceChange?.h1 ?? 0;
        const dexLink = `https://dexscreener.com/${data.chainId}/${addr}`;
        const bmChain = chain === 'SOLANA' ? 'sol' : 'eth';
        await ctx.api.editMessageText(ctx.chat.id, msg.message_id,
          [
            `⚡ <b>$${esc(data.baseToken?.symbol ?? '?')}</b>  ·  <code>${addr.slice(0, 8)}…${addr.slice(-6)}</code>`,
            '',
            `Price: <b>${fmtPriceUsd(data.priceUsd ?? 0)}</b>`,
            `1h: <b>${ch1h >= 0 ? '+' : ''}${ch1h.toFixed(2)}%</b>  ·  24h: <b>${ch24 >= 0 ? '+' : ''}${ch24.toFixed(2)}%</b>`,
            `Vol 24h: <b>${fmtUsd(data.volume?.h24 ?? 0)}</b>  ·  MCap: <b>${fmtUsd(data.fdv ?? 0)}</b>`,
            `Liq: <b>${fmtUsd(data.liquidity?.usd ?? 0)}</b>  ·  Age: <b>${tokenAge(data.pairCreatedAt)}</b>`,
          ].join('\n'),
          {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
            reply_markup: new InlineKeyboard()
              .url('📊 Chart', dexLink)
              .url('🫧 Bubblemap', `https://app.bubblemaps.io/${bmChain}/token/${addr}`)
              .row()
              .text('🔍 Full Scan', `rescan:${addr}`),
          },
        );
      } catch (e: any) {
        await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ ${e.message?.slice(0, 100)}`).catch(() => {});
      }
    });

    /* ── 🔍 /pf — PumpFun scan ──────────────────────────────────────────────── */
    bot.command('pf', async (ctx) => {
      const addr = ctx.match?.trim().split(/\s+/)[0];
      if (!addr) return ctx.reply('Usage: /pf <solana_token_address>');
      if (!detectChain(addr) || detectChain(addr) !== 'SOLANA') {
        return ctx.reply('❌ PumpFun is Solana-only. Provide a Solana base58 address.');
      }
      const pfLink  = `https://pump.fun/${addr}`;
      const dexLink = `https://dexscreener.com/solana/${addr}`;
      await ctx.reply(
        `🟣 <b>PumpFun</b>  ·  <code>${addr.slice(0, 8)}…${addr.slice(-6)}</code>\n\nRunning full scan… ↓`,
        {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: new InlineKeyboard()
            .url('🟣 PumpFun', pfLink)
            .url('📊 DexScreener', dexLink)
            .row()
            .url('🫧 Bubblemap', `https://app.bubblemaps.io/sol/token/${addr}`),
        },
      );
      return this.runScan(ctx, addr);
    });

    /* ── 🔍 /ds — DexScreener pair search ──────────────────────────────────── */
    bot.command('ds', async (ctx) => {
      const query = ctx.match?.trim();
      if (!query) return ctx.reply('Usage: /ds <token_name_or_symbol>\nExample: /ds BONK');
      const msg = await ctx.reply('🔍 <i>Searching DEX pairs…</i>', { parse_mode: 'HTML' });
      try {
        const pairs = await this.fetchDexSearch(query);
        if (!pairs.length) return ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ No pairs found for "${esc(query)}".`);
        const lines = [`🔍 <b>DEX Search:</b> ${esc(query)}`, ''];
        for (let i = 0; i < Math.min(pairs.length, 6); i++) {
          const p = pairs[i];
          const ch24 = p.priceChange?.h24 ?? 0;
          const dex  = `https://dexscreener.com/${p.chainId}/${p.pairAddress}`;
          const addr = p.baseToken?.address ?? '';
          lines.push(`${i + 1}. <b>$${esc(p.baseToken?.symbol ?? '?')}</b>/<b>${esc(p.quoteToken?.symbol ?? '?')}</b>  <code>${p.chainId}</code>`);
          lines.push(`   ${fmtPriceUsd(p.priceUsd ?? 0)}  ${ch24 >= 0 ? '📈' : '📉'} <b>${ch24.toFixed(1)}%</b>  Vol ${fmtUsd(p.volume?.h24 ?? 0)}  <a href="${dex}">📊</a>`);
          if (addr) lines.push(`   <code>${addr.slice(0, 10)}…</code>`);
          lines.push('');
        }
        await ctx.api.editMessageText(ctx.chat.id, msg.message_id, lines.join('\n'), {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        });
      } catch (e: any) {
        await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ ${e.message?.slice(0, 100)}`).catch(() => {});
      }
    });

    /* ── 🔍 /pfs — PumpFun search ───────────────────────────────────────────── */
    bot.command('pfs', async (ctx) => {
      const query = ctx.match?.trim();
      if (!query) return ctx.reply('Usage: /pfs <token_name>\nExample: /pfs pepe');
      const msg = await ctx.reply('🔍 <i>Searching PumpFun…</i>', { parse_mode: 'HTML' });
      try {
        const pairs = await this.fetchDexSearch(query);
        const pumpPairs = pairs.filter(p => p.chainId === 'solana').slice(0, 5);
        if (!pumpPairs.length) return ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ No Solana tokens found for "${esc(query)}".`);
        const lines = [`🟣 <b>PumpFun Search:</b> ${esc(query)}`, ''];
        for (let i = 0; i < pumpPairs.length; i++) {
          const p    = pumpPairs[i];
          const addr = p.baseToken?.address ?? '';
          const ch24 = p.priceChange?.h24 ?? 0;
          lines.push(`${i + 1}. <b>$${esc(p.baseToken?.symbol ?? '?')}</b>  ${fmtPriceUsd(p.priceUsd ?? 0)}  ${ch24 >= 0 ? '📈' : '📉'} ${ch24.toFixed(1)}%`);
          lines.push(`   Vol ${fmtUsd(p.volume?.h24 ?? 0)}  ·  <code>${addr.slice(0, 8)}…</code>  <a href="https://pump.fun/${addr}">🟣</a>  <a href="https://dexscreener.com/solana/${addr}">📊</a>`);
          lines.push('');
        }
        await ctx.api.editMessageText(ctx.chat.id, msg.message_id, lines.join('\n'), {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        });
      } catch (e: any) {
        await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ ${e.message?.slice(0, 100)}`).catch(() => {});
      }
    });

    /* ── 🔍 /dp — DexPaid check ─────────────────────────────────────────────── */
    bot.command('dp', async (ctx) => {
      const addr = ctx.match?.trim().split(/\s+/)[0];
      if (!addr) return ctx.reply('Usage: /dp <token_address>');
      const msg = await ctx.reply('💰 <i>Checking DexPaid…</i>', { parse_mode: 'HTML' });
      try {
        const result = await this.checkDexPaid(addr);
        await ctx.api.editMessageText(ctx.chat.id, msg.message_id,
          [
            `💰 <b>DexPaid Check</b>`,
            `<code>${addr.slice(0, 12)}…${addr.slice(-6)}</code>`,
            '',
            result.paid
              ? `✅ <b>DEX Paid</b>  ·  ${result.details ?? 'Active DexScreener boost'}`
              : `❌ <b>Not Paid</b>  ·  No active promotion found`,
          ].join('\n'),
          { parse_mode: 'HTML' },
        );
      } catch (e: any) {
        await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ ${e.message?.slice(0, 100)}`).catch(() => {});
      }
    });

    /* ── 🔍 /a — CoinGecko lookup ───────────────────────────────────────────── */
    bot.command('a', async (ctx) => {
      const query = ctx.match?.trim();
      if (!query) return ctx.reply('Usage: /a <coin_id_or_name>\nExample: /a bitcoin');
      const msg = await ctx.reply('🦎 <i>Looking up CoinGecko…</i>', { parse_mode: 'HTML' });
      try {
        const coin = await this.fetchCgCoin(query);
        if (!coin) return ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ Coin not found: "${esc(query)}"`);
        const ch24 = coin.price_change_percentage_24h ?? 0;
        await ctx.api.editMessageText(ctx.chat.id, msg.message_id,
          [
            `🦎 <b>${esc(coin.name)}</b>  <code>$${esc((coin.symbol ?? '').toUpperCase())}</code>  Rank <b>#${coin.market_cap_rank ?? '?'}</b>`,
            '',
            `Price: <b>$${fmtNum(coin.current_price ?? 0)}</b>  ${ch24 >= 0 ? '📈' : '📉'} <b>${ch24 >= 0 ? '+' : ''}${ch24.toFixed(2)}%</b> 24h`,
            `MCap: <b>${fmtUsd(coin.market_cap ?? 0)}</b>  ·  Vol 24h: <b>${fmtUsd(coin.total_volume ?? 0)}</b>`,
            `ATH: <b>$${fmtNum(coin.ath ?? 0)}</b>  (<b>${(coin.ath_change_percentage ?? 0).toFixed(0)}%</b> from ATH)`,
          ].join('\n'),
          {
            parse_mode: 'HTML',
            reply_markup: new InlineKeyboard().url('🦎 CoinGecko', `https://www.coingecko.com/en/coins/${coin.id}`),
          },
        );
      } catch (e: any) {
        await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ ${e.message?.slice(0, 100)}`).catch(() => {});
      }
    });

    /* ── 🔍 /soc — Find socials ─────────────────────────────────────────────── */
    bot.command('soc', async (ctx) => {
      const addr = ctx.match?.trim().split(/\s+/)[0];
      if (!addr) return ctx.reply('Usage: /soc <contract_address>');
      const msg = await ctx.reply('🔍 <i>Finding socials…</i>', { parse_mode: 'HTML' });
      try {
        const result = await this.gatherSocials(addr);
        if (!result) {
          return ctx.api.editMessageText(ctx.chat.id, msg.message_id,
            '❌ Could not find this token on DexScreener, GeckoTerminal, or DexScreener search. Double-check the address.');
        }
        const body = this.renderSocials(result.websites, result.socials);
        await ctx.api.editMessageText(ctx.chat.id, msg.message_id,
          [
            `🔗 <b>Socials</b>  ·  <b>$${esc(result.symbol ?? '?')}</b>`,
            `<i>via ${result.sources.join(' + ')}</i>`,
            '',
            body || '<i>No socials published by the team on any source.</i>',
          ].join('\n'),
          { parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
        );
      } catch (e: any) {
        await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ ${e.message?.slice(0, 120)}`).catch(() => {});
      }
    });

    /* ── 🔍 /bsoc — Base chain socials ─────────────────────────────────────── */
    bot.command('bsoc', async (ctx) => {
      const addr = ctx.match?.trim().split(/\s+/)[0];
      if (!addr) return ctx.reply('Usage: /bsoc <base_contract_address>  (0x… format)');
      if (!addr.startsWith('0x')) return ctx.reply('❌ Base chain uses 0x addresses.');
      const msg = await ctx.reply('🔵 <i>Finding Base socials…</i>', { parse_mode: 'HTML' });
      try {
        const result = await this.gatherSocials(addr);
        if (!result) {
          return ctx.api.editMessageText(ctx.chat.id, msg.message_id,
            '❌ Could not find this token on DexScreener, GeckoTerminal, or DexScreener search.');
        }
        const body = this.renderSocials(result.websites, result.socials);
        await ctx.api.editMessageText(ctx.chat.id, msg.message_id,
          [
            `🔵 <b>Base Socials</b>  ·  <b>$${esc(result.symbol ?? '?')}</b>  <code>${esc(result.chainId ?? '?')}</code>`,
            `<i>via ${result.sources.join(' + ')}</i>`,
            '',
            body || '<i>No socials published by the team on any source.</i>',
          ].join('\n'),
          { parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
        );
      } catch (e: any) {
        await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ ${e.message?.slice(0, 120)}`).catch(() => {});
      }
    });

    /* ── 📊 /c — Candlestick chart + info ──────────────────────────────────── */
    bot.command('c', async (ctx) => {
      const parts = (ctx.match?.trim() ?? '').split(/\s+/);
      const addr  = parts[0];
      const tf    = parts[1] ?? '15m';
      if (!addr) return ctx.reply('Usage: /c <token_address> [5m|15m|1h|4h|1d]\nExample: /c HfMb...F5p 1h');
      const chain = detectChain(addr);
      if (!chain) return ctx.reply('❌ Invalid address format.');
      const msg = await ctx.reply('📊 <i>Generating chart…</i>', { parse_mode: 'HTML' });
      try {
        // Suppress fetchDexPair throws here so the search + GeckoTerminal
        // fallback below still runs; we only need a chart, not the full pair.
        const pairData = await this.fetchDexPair(addr).catch(() => null);
        let ohlcv: any[] = [];
        let actualTf = tf;
        let net = '';
        let poolAddr = '';
        let sym = pairData?.baseToken?.symbol ?? addr.slice(0, 8) + '…';

        if (pairData?.pairAddress) {
          net = gtNetwork(pairData.chainId ?? (chain === 'SOLANA' ? 'solana' : 'ethereum'));
          poolAddr = pairData.pairAddress;
        } else {
          // DexScreener token API failed — try search endpoint, then GeckoTerminal
          const searched = await this.fetchDexSearch(addr);
          const best = searched.sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
          if (best?.pairAddress) {
            net = gtNetwork(best.chainId ?? (chain === 'SOLANA' ? 'solana' : 'ethereum'));
            poolAddr = best.pairAddress;
            sym = best.baseToken?.symbol ?? sym;
          } else {
            const gt = await this.fetchGeckoPool(addr, chain);
            if (gt) { net = gt.network; poolAddr = gt.poolAddress; sym = gt.symbol; }
          }
        }

        if (poolAddr) {
          const tryOrder = [tf, ...['5m', '15m', '1h', '4h', '1d'].filter(t => t !== tf)];
          for (const tryTf of tryOrder) {
            try {
              const data = await fetchOhlcv(net, poolAddr, tryTf);
              if (data.length >= 1) { ohlcv = data; actualTf = tryTf; break; }
            } catch (e) {
              if (e instanceof RateLimitedError) {
                // Wait 2s and retry once before giving up
                await new Promise(r => setTimeout(r, 2_000));
                try {
                  const data = await fetchOhlcv(net, poolAddr, tryTf);
                  if (data.length >= 1) { ohlcv = data; actualTf = tryTf; }
                } catch { /* still limited */ }
                break;
              }
            }
          }
        }

        await ctx.api.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {});

        if (ohlcv.length >= 1) {
          const caption = pairData ? buildChartCaption(pairData, actualTf) : `📊 <b>${esc(sym)}</b>  ·  ${actualTf}`;
          const kb = new InlineKeyboard();
          for (const t of ['5m', '15m', '1h', '4h', '1d']) {
            kb.text(t === actualTf ? `· ${t} ·` : t, `chart:${addr}:${t}`);
          }
          const img = await generateCandleChart(ohlcv, sym, actualTf);
          await ctx.replyWithPhoto(new InputFile(img, 'chart.png'), {
            caption,
            parse_mode: 'HTML',
            reply_markup: kb,
          });
        } else if (pairData) {
          // GT unavailable — draw fallback chart from DexScreener price change data
          const caption = buildChartCaption(pairData, tf);
          const kb = new InlineKeyboard();
          for (const t of ['5m', '15m', '1h', '4h', '1d']) {
            kb.text(t === actualTf ? `· ${t} ·` : t, `chart:${addr}:${t}`);
          }
          const img = await generateDexChart(pairData, sym);
          await ctx.replyWithPhoto(new InputFile(img, 'chart.png'), {
            caption,
            parse_mode: 'HTML',
            reply_markup: kb,
          });
        }
      } catch (e: any) {
        this.logger.error(`/c command failed: ${e?.message ?? e}`);
        await ctx.api.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {});
      }
    });

    /* ── 📊 /cc — Chart only ────────────────────────────────────────────────── */
    bot.command('cc', async (ctx) => {
      const addr  = ctx.match?.trim().split(/\s+/)[0];
      if (!addr)  return ctx.reply('Usage: /cc <token_address>');
      const chain = detectChain(addr);
      if (!chain) return ctx.reply('❌ Invalid address format.');
      const url   = `https://dexscreener.com/${chain === 'SOLANA' ? 'solana' : 'ethereum'}/${addr}`;
      return ctx.reply(
        `📊 <code>${addr.slice(0, 8)}…${addr.slice(-6)}</code>`,
        { parse_mode: 'HTML', reply_markup: new InlineKeyboard().url('📊 Open Chart', url).text('+ Info', `rescan:${addr}`) },
      );
    });

    /* ── 📊 /cx — Chart minimal ─────────────────────────────────────────────── */
    bot.command('cx', async (ctx) => {
      const addr  = ctx.match?.trim().split(/\s+/)[0];
      if (!addr)  return ctx.reply('Usage: /cx <token_address>');
      const chain = detectChain(addr);
      if (!chain) return ctx.reply('❌ Invalid address format.');
      const url   = `https://dexscreener.com/${chain === 'SOLANA' ? 'solana' : 'ethereum'}/${addr}`;
      return ctx.reply(`<a href="${url}">📊</a> <code>${addr.slice(0, 8)}…${addr.slice(-6)}</code>`, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
    });

    /* ── 📊 /hm — Heatmap ───────────────────────────────────────────────────── */
    bot.command('hm', async (ctx) => {
      return ctx.reply('🌡️ <b>Market Heatmap</b>', {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard()
          .url('🌡️ Coinglass Liq Map', 'https://www.coinglass.com/pro/futures/LiquidationHeatMap')
          .row()
          .url('🔥 CMC Heatmap', 'https://coinmarketcap.com/charts/')
          .url('🦎 CoinGecko', 'https://www.coingecko.com/en/global-charts'),
      });
    });

    /* ── 📊 /bm — Bubblemap ─────────────────────────────────────────────────── */
    bot.command('bm', async (ctx) => {
      const addr  = ctx.match?.trim().split(/\s+/)[0];
      if (!addr)  return ctx.reply('Usage: /bm <token_address>');
      const chain = detectChain(addr);
      if (!chain) return ctx.reply('❌ Invalid address format.');
      const slug  = chain === 'SOLANA' ? 'sol' : 'eth';
      const url   = `https://app.bubblemaps.io/${slug}/token/${addr}`;
      return ctx.reply(
        `🫧 <b>Bubblemap</b>  ·  <code>${addr.slice(0, 8)}…${addr.slice(-6)}</code>`,
        { parse_mode: 'HTML', reply_markup: new InlineKeyboard().url('🫧 Open Bubblemap', url) },
      );
    });

    /* ── 📈 /macro — Market snapshot ────────────────────────────────────────── */
    bot.command('macro', async (ctx) => {
      const msg = await ctx.reply('📈 <i>Fetching market data…</i>', { parse_mode: 'HTML' });
      try {
        const [global, fng] = await Promise.all([this.fetchCgGlobal(), this.fetchFearGreed()]);
        const btcDom = (global.market_cap_percentage?.btc ?? 0).toFixed(1);
        const ethDom = (global.market_cap_percentage?.eth ?? 0).toFixed(1);
        const totalMcap = global.total_market_cap?.usd ?? 0;
        const vol24h    = global.total_volume?.usd ?? 0;
        const ch24      = global.market_cap_change_percentage_24h_usd ?? 0;
        const fngVal    = fng?.value ?? '?';
        const fngClass  = fng?.value_classification ?? '?';
        const fngIcon   = Number(fngVal) >= 60 ? '😀' : Number(fngVal) >= 40 ? '😐' : '😨';
        await ctx.api.editMessageText(ctx.chat.id, msg.message_id,
          [
            '📈 <b>Crypto Market Snapshot</b>',
            '',
            `Total MCap: <b>${fmtUsd(totalMcap)}</b>  ${ch24 >= 0 ? '📈' : '📉'} <b>${ch24 >= 0 ? '+' : ''}${ch24.toFixed(2)}%</b> 24h`,
            `Vol 24h:    <b>${fmtUsd(vol24h)}</b>`,
            '',
            `BTC Dom: <b>${btcDom}%</b>  ·  ETH Dom: <b>${ethDom}%</b>`,
            '',
            `${fngIcon} Fear &amp; Greed: <b>${fngVal}</b> — <i>${esc(fngClass)}</i>`,
          ].join('\n'),
          {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
            reply_markup: new InlineKeyboard()
              .url('📊 Global Chart', 'https://www.coingecko.com/en/global-charts')
              .url('😨 Fear &amp; Greed', 'https://alternative.me/crypto/fear-and-greed-index/'),
          },
        );
      } catch (e: any) {
        await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ ${e.message?.slice(0, 100)}`).catch(() => {});
      }
    });

    /* ── 📈 /index — Top coins ──────────────────────────────────────────────── */
    bot.command('index', async (ctx) => {
      const page = parseInt(ctx.match?.trim() || '1') || 1;
      const msg  = await ctx.reply('📋 <i>Fetching top coins…</i>', { parse_mode: 'HTML' });
      try {
        const coins  = await this.fetchCgMarkets(page);
        const offset = (page - 1) * 10;
        const lines  = [`📋 <b>Top Coins</b>  ·  Page ${page}`, ''];
        for (let i = 0; i < coins.length; i++) {
          const c   = coins[i];
          const ch  = c.price_change_percentage_24h ?? 0;
          const ico = ch >= 5 ? '🚀' : ch >= 0 ? '📈' : ch >= -5 ? '📉' : '🔴';
          lines.push(`${offset + i + 1}. ${ico} <b>${esc(c.name)}</b>  $${fmtNum(c.current_price ?? 0)}  <b>${ch >= 0 ? '+' : ''}${ch.toFixed(1)}%</b>`);
        }
        await ctx.api.editMessageText(ctx.chat.id, msg.message_id, lines.join('\n'), {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard()
            .text('◀️', `index:${Math.max(1, page - 1)}`)
            .text(`· ${page} ·`, 'noop')
            .text('▶️', `index:${page + 1}`),
        });
      } catch (e: any) {
        await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ ${e.message?.slice(0, 100)}`).catch(() => {});
      }
    });

    /* ── 📈 /gas — ETH gas ──────────────────────────────────────────────────── */
    bot.command('gas', async (ctx) => {
      const msg = await ctx.reply('⛽ <i>Fetching gas prices…</i>', { parse_mode: 'HTML' });
      try {
        const gas = await this.fetchEthGas();
        await ctx.api.editMessageText(ctx.chat.id, msg.message_id,
          [
            '⛽ <b>ETH Gas Prices</b>',
            '',
            `🐢 Slow:     <b>${gas.slow} gwei</b>`,
            `🚗 Standard: <b>${gas.standard} gwei</b>`,
            `⚡ Fast:     <b>${gas.fast} gwei</b>`,
            `🚀 Instant:  <b>${gas.instant} gwei</b>`,
          ].join('\n'),
          { parse_mode: 'HTML', reply_markup: new InlineKeyboard().url('⛽ Etherscan Gas', 'https://etherscan.io/gastracker') },
        );
      } catch (e: any) {
        await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ ${e.message?.slice(0, 100)}`).catch(() => {});
      }
    });

    /* ── 📈 /vol — Volume stats ─────────────────────────────────────────────── */
    bot.command('vol', async (ctx) => {
      const msg = await ctx.reply('📊 <i>Fetching volume…</i>', { parse_mode: 'HTML' });
      try {
        const [global, coins] = await Promise.all([this.fetchCgGlobal(), this.fetchCgMarkets(1)]);
        const vol24h  = global.total_volume?.usd ?? 0;
        const sorted  = [...coins].sort((a, b) => (b.total_volume ?? 0) - (a.total_volume ?? 0)).slice(0, 5);
        const lines   = ['📊 <b>Volume Stats</b>', '', `Total 24h: <b>${fmtUsd(vol24h)}</b>`, '', '<b>Top by 24h Volume:</b>'];
        for (const c of sorted) lines.push(`• <b>${esc(c.name)}</b>  ${fmtUsd(c.total_volume ?? 0)}`);
        await ctx.api.editMessageText(ctx.chat.id, msg.message_id, lines.join('\n'), { parse_mode: 'HTML' });
      } catch (e: any) {
        await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ ${e.message?.slice(0, 100)}`).catch(() => {});
      }
    });

    /* ── 📈 /dt — DEX trending ──────────────────────────────────────────────── */
    bot.command('dt', async (ctx) => {
      const msg = await ctx.reply('🔥 <i>Fetching DEX trending…</i>', { parse_mode: 'HTML' });
      try {
        const items = await this.fetchDexTrending();
        if (!items.length) return ctx.api.editMessageText(ctx.chat.id, msg.message_id, '❌ No trending data right now.');
        const lines = ['🔥 <b>DEX Trending</b>  ·  Top Boosted', ''];
        for (let i = 0; i < Math.min(items.length, 10); i++) {
          const t  = items[i];
          const ch = t.chainId ?? '?';
          const addr = t.tokenAddress ?? '';
          const dexLink = addr ? `https://dexscreener.com/${ch}/${addr}` : (t.url ?? '#');
          lines.push(`${i + 1}. <b>${esc(t.description ?? addr.slice(0, 8) ?? '?')}</b>  <code>${ch}</code>  <a href="${dexLink}">📊</a>`);
          if (addr) lines.push(`   <code>${addr.slice(0, 10)}…</code>`);
          lines.push('');
        }
        await ctx.api.editMessageText(ctx.chat.id, msg.message_id, lines.join('\n'), {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        });
      } catch (e: any) {
        await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ ${e.message?.slice(0, 100)}`).catch(() => {});
      }
    });

    /* ── 📈 /pft — PumpFun trending ─────────────────────────────────────────── */
    bot.command('pft', async (ctx) => {
      const svc  = this.getHotTokens();
      if (!svc)  return ctx.reply('❌ Scanner unavailable.');
      const scan = svc.getLatest('meme_hunter');
      if (!scan?.tokens.length) return ctx.reply('📡 <b>Scanner warming up</b> — retry in ~60s.', { parse_mode: 'HTML' });
      const tokens = scan.tokens.slice(0, 8);
      const lines  = ['🟣 <b>PumpFun Trending</b>', ''];
      for (let i = 0; i < tokens.length; i++) {
        const t   = tokens[i];
        const ch  = `${t.priceChange1h >= 0 ? '+' : ''}${t.priceChange1h.toFixed(1)}%`;
        const pf  = `https://pump.fun/${t.address}`;
        const dex = t.dexUrl ?? `https://dexscreener.com/solana/${t.address}`;
        lines.push(`${i + 1}. <b>$${esc(t.symbol)}</b>  ${fmtPriceUsd(t.priceUsd)}  <b>${ch} 1h</b>`);
        lines.push(`   <code>${t.address.slice(0, 8)}…</code>  <a href="${pf}">🟣</a>  <a href="${dex}">📊</a>`);
        lines.push('');
      }
      return ctx.reply(lines.join('\n'), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: new InlineKeyboard().text('🔄 Refresh', 'action:hot').url('🌐 QWAI', WEB_URL),
      });
    });

    /* ── 👥 /h — Top holders ────────────────────────────────────────────────── */
    bot.command('h', async (ctx) => {
      const addr  = ctx.match?.trim().split(/\s+/)[0];
      if (!addr)  return ctx.reply('Usage: /h <token_address>');
      const chain = detectChain(addr);
      if (!chain) return ctx.reply('❌ Invalid address format.');
      if (chain !== 'SOLANA') {
        return ctx.reply('👥 <b>Top Holders</b>\n\nEVM holder data on Etherscan:', {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard()
            .url('👥 Etherscan Holders', `https://etherscan.io/token/${addr}#balances`)
            .url('🫧 Bubblemap', `https://app.bubblemaps.io/eth/token/${addr}`),
        });
      }
      const msg = await ctx.reply('👥 <i>Fetching top holders…</i>', { parse_mode: 'HTML' });
      try {
        const holders = await this.fetchSolanaTopHolders(addr);
        if (!holders.length) return ctx.api.editMessageText(ctx.chat.id, msg.message_id, '❌ No holder data found.');
        const total = holders.reduce((s: number, h: any) => s + (h.uiAmount ?? 0), 0);
        const lines = [`👥 <b>Top Holders</b>  ·  <code>${addr.slice(0, 8)}…</code>`, ''];
        for (let i = 0; i < Math.min(holders.length, 10); i++) {
          const h   = holders[i];
          const pct = total > 0 ? ((h.uiAmount / total) * 100).toFixed(2) : '?';
          lines.push(`${i + 1}. <code>${(h.address ?? '?').slice(0, 6)}…</code>  <b>${pct}%</b>  (${fmtNum(h.uiAmount)})`);
        }
        lines.push('');
        lines.push(`<a href="https://solscan.io/token/${addr}#holders">📋 Full list</a>  ·  <a href="https://app.bubblemaps.io/sol/token/${addr}">🫧 Bubblemap</a>`);
        await ctx.api.editMessageText(ctx.chat.id, msg.message_id, lines.join('\n'), {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        });
      } catch (e: any) {
        await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ ${e.message?.slice(0, 100)}`).catch(() => {});
      }
    });

    /* ── 👥 /w — Wallet scan ────────────────────────────────────────────────── */
    bot.command('w', async (ctx) => {
      const addr   = ctx.match?.trim().split(/\s+/)[0];
      if (!addr)   return ctx.reply('Usage: /w <wallet_address>');
      const isSol  = addr.length >= 32 && addr.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(addr);
      const isEvm  = /^0x[a-fA-F0-9]{40}$/i.test(addr);
      if (!isSol && !isEvm) return ctx.reply('❌ Invalid wallet address format.');
      const short  = `${addr.slice(0, 8)}…${addr.slice(-6)}`;
      if (isSol) {
        return ctx.reply(`👛 <b>Solana Wallet</b>  ·  <code>${short}</code>`, {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard()
            .url('🔍 Solscan', `https://solscan.io/account/${addr}`)
            .url('📊 SolanaTracker', `https://solanatracker.io/wallet/${addr}`)
            .row()
            .url('🫧 Bubblemap', `https://app.bubblemaps.io/sol/address/${addr}`),
        });
      }
      return ctx.reply(`👛 <b>EVM Wallet</b>  ·  <code>${short}</code>`, {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard()
          .url('🔍 Etherscan', `https://etherscan.io/address/${addr}`)
          .url('💼 DeBank', `https://debank.com/profile/${addr}`),
      });
    });

    /* ── 🤖 /ask — Explicit AI question ────────────────────────────────────── */
    bot.command('ask', async (ctx) => {
      const question = ctx.match?.trim();
      if (!question) return ctx.reply('Usage: /ask <question>\nExample: /ask What is a bonding curve?');
      return this.runChat(ctx, question);
    });

    /* ── 🤖 /tldr — Summarize URL ───────────────────────────────────────────── */
    bot.command('tldr', async (ctx) => {
      const url = ctx.match?.trim();
      if (!url || !url.startsWith('http')) return ctx.reply('Usage: /tldr <url>\nExample: /tldr https://example.com/article');
      const msg = await ctx.reply('⏳ <i>Reading and summarizing…</i>', { parse_mode: 'HTML' });
      try {
        const content = await this.fetchUrlText(url);
        if (!content) return ctx.api.editMessageText(ctx.chat.id, msg.message_id, '❌ Could not read that URL.');
        const summary = await this.llm.chat([
          { role: 'system', content: 'Summarize in 4-5 tight bullet points using Telegram HTML (<b>,<i>). No markdown. Max 400 chars. Lead with the key insight.' },
          { role: 'user',   content: `Summarize:\n\n${content.slice(0, 8000)}` },
        ], 400);
        await ctx.api.editMessageText(ctx.chat.id, msg.message_id,
          `📄 <b>Summary</b>\n<i>${esc(url.slice(0, 60))}</i>\n\n${summary}`,
          { parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
        );
      } catch (e: any) {
        await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ ${e.message?.slice(0, 100)}`).catch(() => {});
      }
    });

    /* ── 🤖 /lore — Token lore / backstory ─────────────────────────────────── */
    bot.command('lore', async (ctx) => {
      const tokens = (ctx.match ?? '').trim().split(/\s+/).filter(Boolean);
      const input = tokens[0];
      if (!input) return ctx.reply(
        'Usage: /lore <token_address_or_name> [light|balanced|aggressive]\n' +
        'Example: /lore BONK\nExample: /lore 7GCi... aggressive (default)',
      );
      const budgetArg = tokens[1]?.toLowerCase().replace(/^--/, '');
      const budget: LoreBudget =
        budgetArg === 'light' ? 'light' :
        budgetArg === 'balanced' ? 'balanced' :
        'aggressive';

      const msg = await ctx.reply('📖 <i>Gathering intel…</i>', { parse_mode: 'HTML' });
      try {
        const isAddr = !!detectChain(input);
        // pump.fun is the authoritative source for utility tokens like $PROG —
        // it has the actual project description that explains what the token
        // DOES. Fetch in parallel with DexScreener for pump-suffix mints.
        const isPumpMint = isAddr && isPumpFunMint(input);
        const [pairData, pumpFunData] = await Promise.all([
          isAddr ? this.fetchDexPair(input).catch(() => null) : Promise.resolve(null),
          isPumpMint
            ? (this.getPumpFun()?.getCoinData(input) ?? Promise.resolve(null)).catch(() => null)
            : Promise.resolve(null),
        ]) as [any, PumpFunCoinData | null];
        const sym  = pairData?.baseToken?.symbol ?? pumpFunData?.symbol ?? input.toUpperCase();
        const name = pairData?.baseToken?.name   ?? pumpFunData?.name   ?? sym;
        const tokenCreatedAt: number | null = pairData?.pairCreatedAt ?? pumpFunData?.createdAt ?? null;

        await ctx.api.editMessageText(ctx.chat.id, msg.message_id,
          `📖 <i>Researching $${esc(sym)}…</i>`, { parse_mode: 'HTML' }).catch(() => {});

        const parts: string[] = [];

        // 1 — on-chain basics from DexScreener (or pump.fun fallback for pre-graduation)
        if (pairData) {
          const age = tokenCreatedAt
            ? `Created ${Math.round((Date.now() - tokenCreatedAt) / 86_400_000)}d ago`
            : '';
          const basics = [
            `TOKEN: $${sym} (${name})`,
            `Price: ${fmtPriceUsd(parseFloat(pairData.priceUsd ?? '0'))}  MCap: ${fmtUsd(pairData.fdv ?? 0)}`,
            `1h: ${(pairData.priceChange?.h1 ?? 0) >= 0 ? '+' : ''}${(pairData.priceChange?.h1 ?? 0).toFixed(1)}%  24h: ${(pairData.priceChange?.h24 ?? 0) >= 0 ? '+' : ''}${(pairData.priceChange?.h24 ?? 0).toFixed(1)}%`,
            age,
          ].filter(Boolean);
          parts.push(...basics);
        } else if (pumpFunData) {
          const age = pumpFunData.createdAt
            ? `Created ${Math.round((Date.now() - pumpFunData.createdAt) / 86_400_000)}d ago`
            : '';
          parts.push(
            `TOKEN: $${sym} (${name})`,
            `MCap: ${fmtUsd(pumpFunData.marketCapUsd)}  ATH: ${fmtUsd(pumpFunData.athMarketCapUsd)}`,
            pumpFunData.graduated ? 'Status: graduated from pump.fun' : `Bonding curve: ${pumpFunData.bondingCurvePct.toFixed(0)}%`,
            age,
          );
        } else {
          parts.push(`TOKEN: ${input}`);
        }

        // 1b — pump.fun project description (the authoritative "what is this token" source).
        // For utility tokens this is the most important piece — it's what Rickbot-style
        // lore is built on. Place it BEFORE Twitter context so the LLM weighs it heavily.
        const pumpDescription = pumpFunData?.description ?? null;
        if (pumpFunData) {
          const pfBits: string[] = [];
          if (pumpDescription) pfBits.push(`Description: ${pumpDescription.slice(0, 500)}`);
          if (pumpFunData.isLive) pfBits.push('🔴 Creator is currently livestreaming on pump.fun');
          if (pumpFunData.replyCount > 0) pfBits.push(`pump.fun replies: ${pumpFunData.replyCount}`);
          if (pfBits.length) parts.push('\nPUMP.FUN CONTEXT (authoritative project info):\n' + pfBits.join('\n'));
        }

        // 2 — CoinGecko description (established tokens)
        let coingeckoDesc: string | null = null;
        const cgNetwork = pairData?.chainId === 'solana' ? 'solana' : 'ethereum';
        const cgAddr = isAddr ? input : null;
        if (cgAddr) {
          const cg = await fetch(
            `https://api.coingecko.com/api/v3/coins/${cgNetwork}/contract/${cgAddr}`,
            { signal: AbortSignal.timeout(5_000) },
          ).then(r => r.ok ? r.json() : null).catch(() => null) as any;
          const desc = (cg?.description?.en ?? '').replace(/<[^>]+>/g, '').slice(0, 600).trim();
          if (desc) {
            coingeckoDesc = desc;
            parts.push(`\nCOINGECKO DESCRIPTION:\n${desc}`);
          }
        }

        // 3 — Token website text
        let websiteText: string | null = null;
        const websiteUrl = pairData?.info?.websites?.[0]?.url ?? pumpFunData?.website ?? null;
        if (websiteUrl) {
          const text = await this.fetchUrlText(websiteUrl);
          if (text) {
            websiteText = text;
            parts.push(`\nWEBSITE CONTENT:\n${text.slice(0, 800)}`);
          }
        }

        // 4 — Twitter/X: engagement-ranked origin + amplifiers (catalyst hunt).
        // Prefer DexScreener's twitter URL (often a /status/<id> pinned tweet);
        // fall back to pump.fun's twitter field for pre-graduation tokens.
        const twitterSocial = pairData?.info?.socials?.find((s: any) => s.type === 'twitter');
        const twitterUrl: string | null = twitterSocial?.url ?? pumpFunData?.twitter ?? null;
        const { handle, tweetId: seedTweetId } = twitterUrl
          ? parseTwitterUrl(twitterUrl)
          : { handle: null, tweetId: null };
        const { context: twitterCtx, sources, highlights } = await this.gatherLoreFromTwitter({
          sym,
          name,
          addr: isAddr ? input : null,
          handle,
          seedTweetId,
          tokenCreatedAt,
          budget,
          // Anchor the Twitter relevance scoring to what the project ACTUALLY
          // is. Without this anchor, "$PROG 50x ape" tweets compete with real
          // project narrative for the LLM's attention.
          descriptionSources: [pumpDescription, coingeckoDesc, websiteText],
        });
        if (twitterCtx) parts.push('\n' + twitterCtx);

        await ctx.api.editMessageText(ctx.chat.id, msg.message_id,
          `📖 <i>Writing $${esc(sym)} lore…</i>`, { parse_mode: 'HTML' }).catch(() => {});

        const context = parts.join('\n');
        // Token type is implied by the data: utility tokens have PUMP.FUN
        // CONTEXT / WEBSITE CONTENT / COINGECKO DESCRIPTION describing what the
        // project does. Meme-reference tokens have a distinctive name + no
        // project description. Celebrity-catalyst tokens have an ORIGIN TWEET.
        // The prompt instructs the LLM to pick the right framing per case.
        const hasOriginTweet = !!highlights.origin;
        const lore = await this.llm.chat([
          {
            role: 'system',
            content:
              'You are a sharp crypto cultural analyst writing the NARRATIVE BODY of a token lore card. ' +
              'A separate header above your text will already display origin tweet author, follower count, engagement stats, the quoted tweet, and an amplifier list. ' +
              'DO NOT restate those numbers/follower counts/repeat the origin tweet — the header shows them. Reference by @handle only. ' +
              '\n\nDECIDE THE FRAMING based on what\'s in the data:\n' +
              '(1) UTILITY/PROJECT token — if the data has PUMP.FUN CONTEXT, WEBSITE CONTENT, or COINGECKO DESCRIPTION explaining what the project actually DOES (mechanics, fees, automation, agents, infrastructure, DeFi primitive, etc.), lead with WHAT IT DOES in concrete terms. Example: "$PROG automates pump.fun creator fees through programmable strategies — buybacks, LP, burns, payouts. It layers on pump.fun\'s Tokenized Agents to enable custom splits and conditional rules." NO Twitter catalyst framing — describe the actual utility, then briefly note community traction.\n' +
              '(2) CELEBRITY CATALYST token — if there\'s a clear ORIGIN TWEET (especially one marked [DELETED — reconstructed from reply chain]), lead with "@<handle>\'s tweet sparked this" and explain why the catalyst mattered.\n' +
              '(3) MEME REVIVAL token — if the name references a well-known meme/character (Pepe, EpicFace, Doge) and there\'s no project description and no celebrity catalyst, tell the meme\'s real backstory and note "community meme revival, no celebrity tweet".\n' +
              '(4) PURE SPECULATION — if none of the above: call it organic shilling, no fluff.\n' +
              `\nFor this token, an origin tweet ${hasOriginTweet ? 'IS' : 'IS NOT'} surfaced in the data. ` +
              (hasOriginTweet
                ? 'Use case (2) framing — but only if the origin is clearly relevant to the token (the project description / website should confirm the connection). If the origin tweet feels unrelated to what the project actually does, fall back to framing (1) and IGNORE the origin tweet in your prose.'
                : 'Use case (1) framing if there\'s a project description; else (3) if name is a known meme; else (4).') +
              '\n\nTWEET TAGS — each amplifier/community tweet is tagged [project-aligned] or [sentiment-only]:\n' +
              '  • [project-aligned] tweets share substantive vocabulary with the project description — they are evidence for WHAT the project does/means. Quote handles from these when explaining mechanics or theme.\n' +
              '  • [sentiment-only] tweets pass our relevance filter (CA or cashtag mention) but DON\'T actually discuss what the project does — they\'re just price-action shill. Use them ONLY for community vibe ("traders are bullish", "X% up", "active chatter") — NEVER cite them as evidence of the project\'s purpose, narrative, or cultural meaning.\n' +
              '\nHard facts (@handles, tweet content, numbers): use ONLY what\'s in the data — never invent. ' +
              'Cultural context (well-known memes, viral phrases): you MAY draw on general knowledge. ' +
              '3-5 sentences. Use Telegram HTML <b> sparingly for the most important @handle or term. No markdown. No bullet lists. Max 500 chars.',
          },
          { role: 'user', content: context },
        ], 500);

        // Build the structured output: header → catalyst block → LLM narrative → amplifiers → sources.
        const blocks: string[] = [`📖 <b>$${esc(sym)} Lore</b>`];

        if (highlights.origin) {
          const o = highlights.origin;
          const verifiedBadge = o.authorVerified ? ' ✓' : '';
          const deletedTag = o.isReconstructed ? ' · <i>now-deleted</i>' : '';
          const stats = o.isReconstructed
            ? `${fmtNum(o.likes)} agg-likes · ${o.replies} reply chains`
            : `${fmtNum(o.likes)} likes · ${fmtNum(o.retweets)} RTs · ${fmtNum(o.views)} views`;
          blocks.push(
            `\n🔥 <b>CATALYST</b>` +
            `\n<b>@${esc(o.authorHandle)}</b>${verifiedBadge} · ${fmtNum(o.authorFollowers)} followers${deletedTag}` +
            `\n<i>${stats}</i>`,
          );
          if (!o.isReconstructed && o.text) {
            blocks.push(`<blockquote>${esc(o.text.slice(0, 280))}</blockquote>`);
          } else if (o.isReconstructed && o.text) {
            // Reconstructed text already has the "(catalyst tweet appears deleted...)" framing — strip the prefix and quote the inferred phrase.
            const inferred = o.text.match(/Inferred content: "([^"]+)"/)?.[1];
            if (inferred) blocks.push(`<blockquote>${esc(inferred.slice(0, 280))}</blockquote>`);
          }
        }

        // The LLM is instructed to use only <b>/<i> sparingly, but occasionally
        // hallucinates <article>/<arena>/etc. — Telegram's HTML parser rejects
        // the whole message in that case. Strip non-whitelisted tags defensively.
        blocks.push(`\n${sanitizeTelegramHtml(lore)}`);

        if (highlights.amplifiers.length) {
          const amps = highlights.amplifiers.map(a =>
            `• <b>@${esc(a.authorHandle)}</b> — ${fmtNum(a.authorFollowers)} followers · ${fmtNum(a.likes)} likes`,
          ).join('\n');
          blocks.push(`\n📣 <b>Top amplifiers</b>\n${amps}`);
        }

        if (highlights.projectProfile && !highlights.origin?.authorHandle?.toLowerCase().includes(highlights.projectProfile.handle.toLowerCase())) {
          const p = highlights.projectProfile;
          blocks.push(`\n🐦 <b>Project account</b>: <b>@${esc(p.handle)}</b> · ${fmtNum(p.followers)} followers`);
        }

        // pump.fun status row — bonding curve %, ATH MC, livestream flag.
        if (pumpFunData) {
          const pfLine: string[] = [];
          if (pumpFunData.graduated) pfLine.push('🎓 <b>graduated</b>');
          else pfLine.push(`📈 bonding <b>${pumpFunData.bondingCurvePct.toFixed(0)}%</b>`);
          if (pumpFunData.athMarketCapUsd > 0) pfLine.push(`ATH <b>${fmtUsd(pumpFunData.athMarketCapUsd)}</b>`);
          if (pumpFunData.isLive) pfLine.push('🔴 <b>LIVE</b>');
          if (pumpFunData.replyCount > 0) pfLine.push(`💬 ${pumpFunData.replyCount}`);
          blocks.push(`\n🚀 <b>pump.fun</b>: ${pfLine.join(' · ')}`);
        }

        if (sources.length) {
          const links = sources.map(s => `<a href="${s.url}">${esc(s.label)}</a>`).join(' · ');
          blocks.push(`\n🔗 ${links}`);
        }

        const output = blocks.join('\n');
        try {
          await ctx.api.editMessageText(ctx.chat.id, msg.message_id, output, {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
          });
        } catch (htmlErr: any) {
          // Surprise tag slipped past the sanitizer (rare). Fall back to a
          // tag-stripped plain-text render so the user still gets the lore.
          if (/can't parse entities|Unsupported start tag/i.test(htmlErr?.description ?? htmlErr?.message ?? '')) {
            this.logger.warn(`/lore HTML render failed, falling back to plain text: ${htmlErr.message}`);
            const plain = output.replace(/<[^>]+>/g, '');
            await ctx.api.editMessageText(ctx.chat.id, msg.message_id, plain, {
              link_preview_options: { is_disabled: true },
            }).catch(() => {});
          } else {
            throw htmlErr;
          }
        }
      } catch (e: any) {
        this.logger.error(`/lore failed: ${e.message}`);
        await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ ${e.message?.slice(0, 100)}`).catch(() => {});
      }
    });

    /* ── 🤖 /aica — AI contract audit ───────────────────────────────────────── */
    bot.command('aica', async (ctx) => {
      const addr  = ctx.match?.trim().split(/\s+/)[0];
      if (!addr)  return ctx.reply('Usage: /aica <contract_address>');
      const chain = detectChain(addr);
      if (!chain) return ctx.reply('❌ Invalid contract address format.');
      return this.runScan(ctx, addr);
    });

    /* ── 🏆 /rank — User rank & XP ─────────────────────────────────────────── */
    bot.command('rank', async (ctx) => {
      const userId = await this.resolveUserId(ctx.chat.id);
      if (!userId) return ctx.reply(NOT_LINKED_TEXT);
      try {
        const [scans, trades, alerts] = await Promise.all([
          this.prisma.intelSnapshot.count({ where: { userId } }),
          this.prisma.trade.count({ where: { userId } }),
          this.prisma.alertEvent.count({ where: { userId } }),
        ]);
        const xp   = scans * 10 + trades * 50 + alerts * 5;
        const rank = xp >= 5000 ? '💎 Diamond' : xp >= 2000 ? '🥇 Gold' : xp >= 500 ? '🥈 Silver' : '🥉 Bronze';
        return ctx.reply(
          [
            `🏆 <b>Your Rank</b>`,
            '',
            `${rank}  ·  <b>${xp} XP</b>`,
            '',
            `Scans:  <b>${scans}</b>  (+${scans * 10} XP)`,
            `Trades: <b>${trades}</b>  (+${trades * 50} XP)`,
            `Alerts: <b>${alerts}</b>  (+${alerts * 5} XP)`,
            '',
            '<i>Scan more tokens and trade to level up.</i>',
          ].join('\n'),
          { parse_mode: 'HTML' },
        );
      } catch (e: any) { return ctx.reply(`❌ Error: ${e.message}`); }
    });

    /* ── 🏆 /gp — Leaderboard ───────────────────────────────────────────────── */
    bot.command('gp', async (ctx) => {
      const msg = await ctx.reply('🏆 <i>Loading leaderboard…</i>', { parse_mode: 'HTML' });
      try {
        const top = await this.prisma.trade.groupBy({
          by: ['userId'],
          _count: { id: true },
          _sum:   { pnlUsd: true },
          orderBy: { _count: { id: 'desc' } },
          take: 10,
        });
        const lines = ['🏆 <b>Leaderboard</b>  ·  Most Trades', ''];
        if (!top.length) { lines.push('<i>No traders yet.</i>'); }
        for (let i = 0; i < top.length; i++) {
          const t    = top[i];
          const pnl  = t._sum.pnlUsd ?? 0;
          const pStr = pnl !== 0 ? `  P&L <b>${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)}</b>` : '';
          const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
          lines.push(`${medal} <code>${t.userId.slice(0, 8)}…</code>  <b>${t._count.id} trades</b>${pStr}`);
        }
        await ctx.api.editMessageText(ctx.chat.id, msg.message_id, lines.join('\n'), { parse_mode: 'HTML' });
      } catch (e: any) {
        await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ ${e.message?.slice(0, 100)}`).catch(() => {});
      }
    });

    /* ── 🏆 /ga — ATH leaderboard ───────────────────────────────────────────── */
    bot.command('ga', async (ctx) => {
      const msg = await ctx.reply('🏆 <i>Loading ATH board…</i>', { parse_mode: 'HTML' });
      try {
        const best = await this.prisma.trade.findMany({
          where:   { pnlUsd: { gt: 0 } },
          orderBy: { pnlUsd: 'desc' },
          take:    10,
          select:  { userId: true, tokenOut: true, pnlUsd: true, createdAt: true },
        });
        const lines = ['🏆 <b>ATH Board</b>  ·  Best Trades Ever', ''];
        if (!best.length) { lines.push('<i>No winning trades yet.</i>'); }
        for (let i = 0; i < best.length; i++) {
          const t     = best[i];
          const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
          lines.push(`${medal} <b>${esc(t.tokenOut)}</b>  +$${(t.pnlUsd ?? 0).toFixed(0)}  <i>${timeAgo(t.createdAt)}</i>`);
        }
        await ctx.api.editMessageText(ctx.chat.id, msg.message_id, lines.join('\n'), { parse_mode: 'HTML' });
      } catch (e: any) {
        await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ ${e.message?.slice(0, 100)}`).catch(() => {});
      }
    });

    /* ── 🛠 /bridge — Bridge links ──────────────────────────────────────────── */
    bot.command('bridge', async (ctx) => {
      return ctx.reply('🌉 <b>Cross-Chain Bridges</b>', {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard()
          .url('🌉 deBridge',  'https://app.debridge.finance/')
          .url('🔗 Stargate',  'https://stargate.finance/')
          .row()
          .url('⚡ Wormhole',  'https://portalbridge.com/')
          .url('🌀 Relay',     'https://relay.link/')
          .row()
          .url('🔵 Base Bridge','https://bridge.base.org/')
          .url('🟡 Hop',       'https://app.hop.exchange/'),
      });
    });

    /* ── 🛠 /tz — World timezones ───────────────────────────────────────────── */
    bot.command('tz', async (ctx) => {
      const now = new Date();
      const fmt = (tz: string) => now.toLocaleTimeString('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
      return ctx.reply(
        [
          '🕐 <b>World Clocks</b>  ·  ' + now.toUTCString().slice(0, 16),
          '',
          `🌐 UTC:           <b>${fmt('UTC')}</b>`,
          `🗽 New York:      <b>${fmt('America/New_York')}</b>`,
          `🏰 London:        <b>${fmt('Europe/London')}</b>`,
          `🏛 Frankfurt:     <b>${fmt('Europe/Berlin')}</b>`,
          `🏙 Dubai:         <b>${fmt('Asia/Dubai')}</b>`,
          `🇸🇬 Singapore:    <b>${fmt('Asia/Singapore')}</b>`,
          `🗼 Tokyo:         <b>${fmt('Asia/Tokyo')}</b>`,
          `🌁 San Francisco: <b>${fmt('America/Los_Angeles')}</b>`,
        ].join('\n'),
        { parse_mode: 'HTML' },
      );
    });

    /* ── 🛠 /epoch — Convert epoch timestamp ────────────────────────────────── */
    bot.command('epoch', async (ctx) => {
      const raw = ctx.match?.trim();
      if (!raw) {
        const now = Math.floor(Date.now() / 1000);
        return ctx.reply(`🕒 Current epoch: <code>${now}</code>\n\nUsage: /epoch &lt;timestamp&gt;`, { parse_mode: 'HTML' });
      }
      const ts   = parseInt(raw);
      if (isNaN(ts)) return ctx.reply('❌ Invalid timestamp. Provide a Unix epoch number.');
      const date = new Date(ts > 1e12 ? ts : ts * 1000);
      if (isNaN(date.getTime())) return ctx.reply('❌ Invalid timestamp.');
      return ctx.reply(
        `🕒 <b>Epoch → Date</b>\n\nInput: <code>${ts}</code>\nUTC:   <b>${date.toUTCString()}</b>\nISO:   <code>${date.toISOString()}</code>`,
        { parse_mode: 'HTML' },
      );
    });

    /* ── 🛠 /remindme — Set reminder ────────────────────────────────────────── */
    bot.command('remindme', async (ctx) => {
      const args = ctx.match?.trim();
      if (!args) {
        return ctx.reply(
          [
            '⏰ <b>Reminder Usage:</b>',
            '<code>/remindme &lt;time&gt; &lt;message&gt;</code>',
            '',
            'Examples:',
            '<code>/remindme 15m check BONK price</code>',
            '<code>/remindme 1h buy the dip</code>',
            '<code>/remindme 2d review portfolio</code>',
            '',
            'Units: <code>s</code> sec · <code>m</code> min · <code>h</code> hr · <code>d</code> day',
          ].join('\n'),
          { parse_mode: 'HTML' },
        );
      }
      const match = args.match(/^(\d+)(s|m|h|d)\s+(.+)$/i);
      if (!match) return ctx.reply('❌ Format: /remindme <amount><s|m|h|d> <message>\nExample: /remindme 15m check BONK');
      const [, amount, unit, message] = match;
      const ms: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
      const delay = parseInt(amount) * (ms[unit.toLowerCase()] ?? 60_000);
      if (delay > 7 * 86_400_000) return ctx.reply('❌ Max reminder time is 7 days.');
      if (delay < 5_000)          return ctx.reply('❌ Min reminder time is 5 seconds.');
      const chatId = ctx.chat.id;
      const key    = `${chatId}:${Date.now()}`;
      const timer  = setTimeout(async () => {
        this.reminders.delete(key);
        await this._bot?.api.sendMessage(chatId, `⏰ <b>Reminder!</b>\n\n${esc(message)}`, { parse_mode: 'HTML' }).catch(() => {});
      }, delay);
      this.reminders.set(key, timer);
      const humanTime = delay < 3_600_000 ? `${Math.round(delay / 60_000)}m` : delay < 86_400_000 ? `${Math.round(delay / 3_600_000)}h` : `${Math.round(delay / 86_400_000)}d`;
      return ctx.reply(
        `✅ <b>Reminder set</b>  ·  <b>${humanTime}</b>\n\n<i>${esc(message)}</i>`,
        { parse_mode: 'HTML' },
      );
    });

    /* ── 🛠 /v — Value calculator ───────────────────────────────────────────── */
    bot.command('v', async (ctx) => {
      const parts = (ctx.match?.trim() ?? '').split(/\s+/);
      const amount = parseFloat(parts[0]);
      const token  = parts.slice(1).join(' ');
      if (!token || isNaN(amount)) {
        return ctx.reply(
          '💰 <b>Value Calc:</b>\n<code>/v &lt;amount&gt; &lt;token_address_or_symbol&gt;</code>\n\nExamples:\n<code>/v 1000 HfMb...F5p</code>\n<code>/v 0.5 SOL</code>',
          { parse_mode: 'HTML' },
        );
      }
      const msg = await ctx.reply('💰 <i>Calculating…</i>', { parse_mode: 'HTML' });
      try {
        let priceUsd = 0;
        let symbol   = token.toUpperCase();
        if (detectChain(token)) {
          const data = await this.fetchDexPair(token);
          if (!data) throw new Error('Token not found on DexScreener');
          priceUsd = data.priceUsd ?? 0;
          symbol   = `$${data.baseToken?.symbol ?? token}`;
        } else {
          const cgId = CG_COMMON_IDS[token.toLowerCase()];
          if (!cgId) throw new Error(`Unknown token "${token}". Use a contract address for precision.`);
          const res  = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${cgId}&vs_currencies=usd`, { signal: AbortSignal.timeout(5_000) });
          const data = await res.json() as any;
          priceUsd   = data[cgId]?.usd ?? 0;
          symbol     = `$${token.toUpperCase()}`;
        }
        await ctx.api.editMessageText(ctx.chat.id, msg.message_id,
          [
            '💰 <b>Value Calculator</b>',
            '',
            `<b>${fmtNum(amount)}</b> ${esc(symbol)}`,
            `@ <b>${fmtPriceUsd(priceUsd)}</b> each`,
            '',
            `= <b>$${fmtNum(amount * priceUsd)}</b>`,
          ].join('\n'),
          { parse_mode: 'HTML' },
        );
      } catch (e: any) {
        await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `❌ ${e.message?.slice(0, 150)}`).catch(() => {});
      }
    });

    /* ── ⚙️ /settings ───────────────────────────────────────────────────────── */
    bot.command('settings', async (ctx) => {
      const userId = await this.resolveUserId(ctx.chat.id);
      return ctx.reply(
        [
          '⚙️ <b>QWAI Bot Settings</b>',
          '',
          '🔗 Account: ' + (userId ? '✅ Linked' : '❌ Not linked — use /login'),
          '',
          '<b>Quick commands:</b>',
          '/paper — toggle paper/live mode',
          '/kill  — emergency stop all agents',
          '/dca   — manage DCA orders',
          '/snipe — sniper bot config',
          '/alerts — view recent alerts',
          '',
          '<b>Full settings in the dashboard:</b>',
        ].join('\n'),
        {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard()
            .url('⚙️ Open Settings', `${WEB_URL}/settings`)
            .url('📊 Dashboard', WEB_URL),
        },
      );
    });

    /* ── 📊 Chart timeframe button callbacks ────────────────────────────────── */
    bot.callbackQuery(/^chart:(.+):(\w+)$/, async (ctx) => {
      const [, addr, tf] = ctx.match;
      const chain = detectChain(addr);
      if (!chain) { await ctx.answerCallbackQuery(); return; }
      await ctx.answerCallbackQuery('Loading…');
      try {
        // Suppress throws so the GeckoTerminal fallback still runs.
        const pair = await this.fetchDexPair(addr).catch(() => null);
        let sym = pair?.baseToken?.symbol ?? addr.slice(0, 8) + '…';
        let net = '';
        let poolAddr = '';

        if (pair?.pairAddress) {
          net = gtNetwork(pair.chainId ?? (chain === 'SOLANA' ? 'solana' : 'ethereum'));
          poolAddr = pair.pairAddress;
        } else {
          const gt = await this.fetchGeckoPool(addr, chain);
          if (gt) { net = gt.network; poolAddr = gt.poolAddress; sym = gt.symbol; }
        }

        if (!poolAddr) return; // silently drop — no pair on any source

        let ohlcv: any[] = [];
        let actualTf = tf;
        const tryOrder = [tf, ...['5m', '15m', '1h', '4h', '1d'].filter(t => t !== tf)];
        for (const tryTf of tryOrder) {
          try {
            const data = await fetchOhlcv(net, poolAddr, tryTf);
            if (data.length >= 1) { ohlcv = data; actualTf = tryTf; break; }
          } catch (e) {
            if (e instanceof RateLimitedError) {
              await new Promise(r => setTimeout(r, 2_000));
              try {
                const data = await fetchOhlcv(net, poolAddr, tryTf);
                if (data.length >= 1) { ohlcv = data; actualTf = tryTf; }
              } catch { /* still limited */ }
              break;
            }
          }
        }

        if (!ohlcv.length) return; // silently drop — no candle data on any TF or source

        const kb = new InlineKeyboard();
        for (const t of ['5m', '15m', '1h', '4h', '1d']) {
          kb.text(t === actualTf ? `· ${t} ·` : t, `chart:${addr}:${t}`);
        }

        const actualCaption = pair ? buildChartCaption(pair, actualTf) : `📊 <b>${esc(sym)}</b>  ·  ${actualTf}`;
        const img = await generateCandleChart(ohlcv, sym, actualTf);
        await ctx.editMessageMedia(
          { type: 'photo', media: new InputFile(img, 'chart.png'), caption: actualCaption, parse_mode: 'HTML' },
          { reply_markup: kb },
        );
      } catch { /* */ }
    });

    /* ── 📋 /index pagination callbacks ─────────────────────────────────────── */
    bot.callbackQuery(/^index:(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const page   = parseInt(ctx.match[1]) || 1;
      const offset = (page - 1) * 10;
      try {
        const coins = await this.fetchCgMarkets(page);
        const lines = [`📋 <b>Top Coins</b>  ·  Page ${page}`, ''];
        for (let i = 0; i < coins.length; i++) {
          const c  = coins[i];
          const ch = c.price_change_percentage_24h ?? 0;
          const ic = ch >= 5 ? '🚀' : ch >= 0 ? '📈' : ch >= -5 ? '📉' : '🔴';
          lines.push(`${offset + i + 1}. ${ic} <b>${esc(c.name)}</b>  $${fmtNum(c.current_price ?? 0)}  <b>${ch >= 0 ? '+' : ''}${ch.toFixed(1)}%</b>`);
        }
        await ctx.editMessageText(lines.join('\n'), {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard()
            .text('◀️', `index:${Math.max(1, page - 1)}`).text(`· ${page} ·`, 'noop').text('▶️', `index:${page + 1}`),
        });
      } catch { /* */ }
    });

    bot.callbackQuery('noop', async (ctx) => ctx.answerCallbackQuery());

    /* ── Inline callbacks ───────────────────────────────────────────────────── */
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
        case 'hot': return this.runHotTokens(ctx);
        case 'portfolio': {
          const uid = await this.resolveUserId(chatId);
          if (!uid) return ctx.reply(NOT_LINKED_TEXT);
          return this.replyPortfolio(ctx, uid);
        }
        case 'alerts': {
          const uid = await this.resolveUserId(chatId);
          if (!uid) return ctx.reply(NOT_LINKED_TEXT);
          return this.replyAlerts(ctx, uid);
        }
        case 'kill':  return ctx.reply('Use /kill to engage the emergency stop.');
        case 'paper': return ctx.reply('Use /paper to toggle paper trading mode.');
        default:      return ctx.reply(`Unknown action: ${action}`);
      }
    });

    /* snipe on/off inline buttons from /snipe card */
    bot.callbackQuery(/^snipe:(on|off)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const userId = await this.resolveUserId(ctx.chat!.id);
      if (!userId) return ctx.reply(NOT_LINKED_TEXT);
      const enable = ctx.match[1] === 'on';
      try {
        if (enable) {
          const config = await this.prisma.snipeConfig.findUnique({ where: { userId } });
          if (!config) return ctx.reply('❌ Configure sniper at the dashboard first: ' + WEB_URL + '/settings');
          await this.prisma.snipeConfig.update({ where: { userId }, data: { enabled: true } });
          return ctx.reply('✅ Sniper enabled.', { parse_mode: 'HTML' });
        } else {
          await this.prisma.snipeConfig.updateMany({ where: { userId }, data: { enabled: false } });
          this.snipeGroup?.stopUserSession(userId);
          return ctx.reply('🔴 Sniper disabled.', { parse_mode: 'HTML' });
        }
      } catch (e: any) { return ctx.reply(`❌ Error: ${e.message}`); }
    });

    bot.callbackQuery(/^confirm:kill$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const userId = await this.resolveUserId(ctx.chat!.id);
      if (!userId) return ctx.reply(NOT_LINKED_TEXT);
      try {
        await this.prisma.guardrailConfig.upsert({
          where: { userId },
          update: { killSwitch: true },
          create: { userId, killSwitch: true, whitelist: [], blacklist: [], maxSlippageBps: 5000 },
        });
        const paused = await this.prisma.agent.updateMany({
          where: { userId, status: AgentStatus.RUNNING },
          data: { status: AgentStatus.PAUSED },
        });
        return ctx.reply(
          [
            '🛑 <b>Kill Switch Engaged</b>',
            '',
            `All trading halted. <b>${paused.count}</b> agent(s) paused.`,
            '',
            '<i>Re-enable from web dashboard → Settings → Guardrails.</i>',
          ].join('\n'),
          { parse_mode: 'HTML' },
        );
      } catch (e: any) { return ctx.reply(`❌ Error: ${e.message}`); }
    });

    bot.callbackQuery(/^confirm:cancel$/, async (ctx) => {
      await ctx.answerCallbackQuery('Cancelled');
      return ctx.reply('Cancelled.');
    });

    bot.callbackQuery(/^confirm:(buy|sell):(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const [, action, args] = ctx.match;
      const userId = await this.resolveUserId(ctx.chat!.id);
      if (!userId) return ctx.reply(NOT_LINKED_TEXT);
      const loadMsg = await ctx.reply('⏳ <i>Executing trade…</i>', { parse_mode: 'HTML' });
      try {
        const reply = await this.agent.chat(userId, `Confirmed — ${action} ${args}. Execute the trade now.`, 'telegram');
        try { await ctx.api.deleteMessage(ctx.chat!.id, loadMsg.message_id); } catch { /* */ }
        return ctx.reply(reply ?? '…', {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        });
      } catch (e: any) {
        try { await ctx.api.deleteMessage(ctx.chat!.id, loadMsg.message_id); } catch { /* */ }
        return ctx.reply(`❌ Trade failed: ${e.message}`);
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
      } catch (e: any) { return ctx.reply(`❌ Error: ${e.message}`); }
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
      } catch (e: any) { return ctx.reply(`❌ Error: ${e.message}`); }
    });

    bot.callbackQuery(/^snooze:(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery('Snoozed');
      return ctx.reply('🔕 Alert snoozed.');
    });

    /* ── Rescan callback (inline button on scan results) ────────────────────── */
    bot.callbackQuery(/^rescan:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery('Rescanning…');
      return this.runScan(ctx, ctx.match[1], true);
    });

    /* ── Channel posts → sniper hot path ────────────────────────────────────── */
    bot.on('channel_post:text', async (ctx) => {
      if (!this.snipeGroup) return;
      const groupId = String(ctx.chat.id);
      this.snipeGroup.handleGroupMessage(groupId, ctx.channelPost.text ?? '')
        .catch(e => this.logger.error(`snipeGroup channel_post: ${e.message}`));
    });

    /* ── Catch-all message handler ──────────────────────────────────────────── */
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

      // Unknown command — suggest closest matches
      if (text.startsWith('/')) {
        const typed = text.slice(1).split(/[\s@]/)[0].toLowerCase();
        const hits   = findSimilarCommands(typed);
        if (hits.length) {
          return ctx.reply(
            [
              `❓ Unknown command: <code>/${esc(typed)}</code>`,
              '',
              'Did you mean:',
              ...hits.map(c => `• <code>/${c.command}</code> — ${c.description}`),
              '',
              '<i>Type /start for the full command list.</i>',
            ].join('\n'),
            { parse_mode: 'HTML' },
          );
        }
        return ctx.reply(
          `❓ Unknown command: <code>/${esc(typed)}</code>\n\nType /start to see all available commands.`,
          { parse_mode: 'HTML' },
        );
      }

      // Private chat: auto-detect CA → scan.
      if (detectChain(text)) return this.runScan(ctx, text);
      const embedded = extractAddress(text);
      if (embedded) return this.runScan(ctx, embedded);

      // Hot tokens shortcut — bypass LLM, format directly
      if (this.isHotTokensQuery(text)) {
        return this.runHotTokens(ctx);
      }

      // Everything else → AI with loading indicator
      return this.runChat(ctx, text);
    });
  }

  /* ── Portfolio reply (shared by /portfolio command + action:portfolio button) */
  private async replyPortfolio(ctx: any, userId: string): Promise<void> {
    try {
      const [wallets, trades, user] = await Promise.all([
        this.prisma.wallet.findMany({
          where: { userId },
          select: { chain: true, address: true, label: true, isPrimary: true },
        }),
        this.prisma.trade.findMany({
          where: { userId, mode: TradeMode.LIVE },
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: { side: true, tokenIn: true, tokenOut: true, priceUsd: true, pnlUsd: true, createdAt: true },
        }),
        this.prisma.user.findUnique({
          where: { id: userId },
          select: { paperMode: true },
        }),
      ]);

      const totalPnl = trades.reduce((s, t) => s + (t.pnlUsd ?? 0), 0);
      const lines: string[] = ['📊 <b>Portfolio</b>', ''];

      if (wallets.length === 0) {
        lines.push('<i>No wallets yet.</i>');
        lines.push(`<a href="${WEB_URL}/wallets">Create a wallet →</a>`);
      } else {
        for (const w of wallets) {
          const star = w.isPrimary ? '⭐' : '·';
          const addr = `${w.address.slice(0, 6)}…${w.address.slice(-4)}`;
          const label = w.label ? `  <i>${esc(w.label)}</i>` : '';
          lines.push(`${star} <b>${w.chain}</b>  <code>${addr}</code>${label}`);
        }
      }

      lines.push('');
      lines.push(`Mode: ${user?.paperMode ? '📄 <b>Paper</b>' : '🔴 <b>Live</b>'}`);

      if (trades.length > 0) {
        lines.push('');
        lines.push('<b>Recent Trades</b>');
        for (const t of trades) {
          const sideIcon = t.side === 'buy' ? '🟢' : '🔴';
          const pnlStr = t.pnlUsd != null
            ? `  P&L <b>${t.pnlUsd >= 0 ? '+' : ''}$${t.pnlUsd.toFixed(2)}</b>`
            : '';
          lines.push(`${sideIcon} ${t.side.toUpperCase()} <b>${esc(t.tokenOut)}</b>  $${(t.priceUsd ?? 0).toFixed(2)}${pnlStr}  <i>${timeAgo(t.createdAt)}</i>`);
        }
        lines.push('');
        const pnlIcon = totalPnl >= 0 ? '📈' : '📉';
        lines.push(`${pnlIcon} Total P&L: <b>${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}</b>`);
      } else {
        lines.push('');
        lines.push('<i>No live trades yet. Use /buy to make your first trade.</i>');
      }

      await ctx.reply(lines.join('\n'), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: new InlineKeyboard()
          .url('🌐 Full Dashboard', `${WEB_URL}/wallets`)
          .text('🔄 Refresh', 'action:portfolio'),
      });
    } catch (e: any) {
      await ctx.reply(`❌ Error loading portfolio: ${e.message}`);
    }
  }

  /* ── Alerts reply (shared by /alerts command + action:alerts button) ──────── */
  private async replyAlerts(ctx: any, userId: string): Promise<void> {
    const SEV_ICON: Record<string, string> = {
      CRITICAL: '🚨', HIGH: '🔴', MEDIUM: '🟡', LOW: '🟢', INFO: 'ℹ️',
    };
    try {
      const events = await this.prisma.alertEvent.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 10,
      });

      if (events.length === 0) {
        return ctx.reply('🔔 <b>Alerts</b>\n\n<i>No alerts yet. They appear here when your agents trigger signals or guardrails fire.</i>', { parse_mode: 'HTML' });
      }

      const lines = ['🔔 <b>Recent Alerts</b>', ''];
      for (const e of events) {
        const icon = SEV_ICON[e.severity] ?? 'ℹ️';
        const payload = e.payload as any;
        const msg = payload?.message ?? payload?.reason ?? payload?.token ?? '';
        const read = e.readAt ? '' : ' <b>·</b>';
        lines.push(`${icon}${read} <b>${esc(e.kind)}</b>  <i>${timeAgo(e.createdAt)}</i>`);
        if (msg) lines.push(`   ${esc(String(msg).slice(0, 120))}`);
      }

      return ctx.reply(lines.join('\n'), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
    } catch (e: any) {
      return ctx.reply(`❌ Error loading alerts: ${e.message}`);
    }
  }

  /* ── Hot-tokens direct formatter (no LLM) ───────────────────────────────── */
  private isHotTokensQuery(text: string): boolean {
    return /hot\s*tokens?|trending\s*(tokens?|coins?)|top\s*\d*\s*(tokens?|coins?)|what.*(hot|trending|pumping|mooning)|show.*tokens?|list.*tokens?|best\s*(tokens?|coins?)\s*today|pump|gem/i.test(text);
  }

  private async runHotTokens(ctx: any): Promise<void> {
    const svc = this.getHotTokens();
    if (!svc) {
      return ctx.reply('📡 <b>Scanner unavailable.</b>', { parse_mode: 'HTML' });
    }

    // On Refresh button tap: if cache is stale (> 45s), pull fresh data directly.
    const STALE_MS = 45_000;
    const cached = svc.getLatest('meme_hunter');
    const cacheAgeMs = cached ? Date.now() - new Date(cached.scannedAt).getTime() : Infinity;
    let scan = (ctx.callbackQuery && cacheAgeMs > STALE_MS)
      ? await svc.fetchTopDirect().catch(() => cached)
      : cached;

    // Fall back to any profile that has results if meme_hunter is empty
    if (!scan?.tokens.length) {
      const all = svc.getAllLatest();
      if (all) {
        for (const [profileKey, tokens] of Object.entries(all.byProfile)) {
          if (tokens.length > 0) {
            scan = svc.getLatest(profileKey);
            break;
          }
        }
      }
    }

    if (!scan || !scan.tokens.length) {
      return ctx.reply(
        '📡 <b>Scanner warming up</b>\n\n<i>First scan runs at startup — retry in ~60s.</i>',
        { parse_mode: 'HTML' },
      );
    }

    const tokens   = scan.tokens.slice(0, 10);
    const ageMs    = Date.now() - new Date(scan.scannedAt).getTime();
    const ageStr   = ageMs < 60_000 ? 'just now' : `${Math.floor(ageMs / 60_000)}m ago`;
    const pipeline = this.getSignalPipeline();

    const VERDICT_ICON: Record<string, string> = {
      STRONG_BUY: '🚀', BUY: '📈', CAUTIOUS: '⚠️', SKIP: '⏭', HIGH_RISK: '🚨',
    };

    const lines: string[] = [
      `🔥 <b>Top ${tokens.length} Hot Tokens</b>  ·  <i>${ageStr}</i>`,
      '',
    ];

    for (let i = 0; i < tokens.length; i++) {
      const t       = tokens[i];
      const icon    = VERDICT_ICON[t.verdict] ?? '•';
      const price   = fmtPriceUsd(t.priceUsd);
      const ch1h    = `${t.priceChange1h >= 0 ? '+' : ''}${t.priceChange1h.toFixed(1)}%`;
      const ch5m    = t.priceChange5m !== 0
        ? ` · ${t.priceChange5m >= 0 ? '+' : ''}${t.priceChange5m.toFixed(1)}% 5m`
        : '';
      const mcap    = fmtUsd(t.marketCapUsd);
      const vol     = fmtUsd(t.volume24hUsd);
      const dexLink = t.dexUrl ?? `https://dexscreener.com/solana/${t.address}`;

      lines.push(`${i + 1}. ${icon} <b>$${esc(t.symbol)}</b>  ·  ${esc(price)}  ·  <b>${ch1h} 1h</b>${ch5m}`);
      lines.push(`   <code>${t.address}</code>  <a href="${dexLink}">📊</a>`);
      lines.push(`   Score <b>${t.score}</b>  ·  MCap ${mcap}  ·  Vol ${vol}`);
      const sig = pipeline?.getResult(t.address);
      if (sig && sig.score >= 62) {
        const t1 = sig.t1Pct != null   ? ` · T1 <b>+${sig.t1Pct.toFixed(0)}%</b>`       : '';
        const sl = sig.stopLossPct != null ? ` · SL ${sig.stopLossPct.toFixed(0)}%`       : '';
        const rr = sig.riskReward != null  ? ` · R/R <b>${sig.riskReward.toFixed(1)}x</b>` : '';
        lines.push(`   🤖 <b>${sig.verdict} ${sig.score}</b>${t1}${sl}${rr}`);
      }
      lines.push('');
    }

    lines.push(`<a href="${WEB_URL}/intel">🔍 Deep-scan any token →</a>`);

    const msgOpts = {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: new InlineKeyboard()
        .text('🔄 Refresh', 'action:hot')
        .url('🌐 QWAI', WEB_URL),
    };

    if (ctx.callbackQuery) {
      try { return await ctx.editMessageText(lines.join('\n'), msgOpts); } catch { /* fall through */ }
    }
    return ctx.reply(lines.join('\n'), msgOpts);
  }

  /* ── General chat with loading indicator ────────────────────────────────── */
  private async runChat(ctx: any, text: string): Promise<void> {
    let msgId: number | undefined;
    try {
      const m = await ctx.reply('⏳ <i>Thinking…</i>', { parse_mode: 'HTML' });
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
        const reply = await this.agent.chat(userId, text, 'telegram');
        await editOrReply(reply ?? '…', {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        });
      } else {
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

    let placeholderMsgId: number | undefined;
    try {
      const msg = await ctx.reply(formatPlaceholder(address), { parse_mode: 'HTML' });
      placeholderMsgId = msg.message_id;
    } catch { /* */ }

    const editOrReply = async (text: string, opts: Record<string, any>) => {
      if (placeholderMsgId) {
        try {
          return await ctx.api.editMessageText(ctx.chat.id, placeholderMsgId, text, opts);
        } catch { /* */ }
      }
      return ctx.reply(text, opts);
    };

    try {
      const report = await svc.analyzeAddress(address, force, 'telegram_scan');

      const result = report.kill?.triggered
        ? formatKillReport(report, address, WEB_URL)
        : formatScanReport(report, address, WEB_URL);

      result.keyboard.row().text('🔄 Rescan', `rescan:${address}`);

      await editOrReply(result.text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: result.keyboard,
      });

      if (!force) {
        svc.analyzeWithProfile(address, 'meme_hunter', 'alpha', false, null, 'telegram_scan')
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

  /* ── API helpers ─────────────────────────────────────────────────────────── */

  private async fetchDexPair(address: string): Promise<any | null> {
    // Distinguish "DexScreener said no pairs" (return null) from transient
    // failures (throw). The /soc, /bsoc, /c, /info handlers' catch blocks
    // surface the thrown message so users see the real reason instead of a
    // misleading "Token not found".
    const url = `https://api.dexscreener.com/latest/dex/tokens/${address}`;
    let lastErr: string | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'qwai/1.0' },
          signal: AbortSignal.timeout(10_000),
        });
        if (res.status === 429) {
          lastErr = 'DexScreener rate-limited (429), try again in a moment';
        } else if (res.status >= 500) {
          lastErr = `DexScreener upstream error (${res.status})`;
        } else if (!res.ok) {
          throw new Error(`DexScreener returned ${res.status}`);
        } else {
          const body = await res.json() as any;
          const pairs: any[] = Array.isArray(body?.pairs) ? body.pairs : [];
          if (!pairs.length) return null;
          return pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
        }
      } catch (e: any) {
        lastErr = e?.name === 'TimeoutError' || e?.name === 'AbortError'
          ? 'DexScreener request timed out'
          : `DexScreener fetch failed: ${e?.message ?? 'unknown'}`;
      }
      if (attempt === 1) await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error(lastErr ?? 'DexScreener unreachable');
  }

  private async fetchGeckoPool(address: string, chain: string): Promise<{ poolAddress: string; symbol: string; network: string } | null> {
    const network = chain === 'SOLANA' ? 'solana' : chain === 'ETH' ? 'eth' : 'solana';
    try {
      const gtHeaders: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'qwai/1.0' };
      const gtKey = process.env.GECKO_TERMINAL_API_KEY;
      if (gtKey) gtHeaders['x-cg-demo-api-key'] = gtKey;
      const res = await fetch(
        `https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${address}/pools?page=1`,
        { headers: gtHeaders, signal: AbortSignal.timeout(6_000) },
      );
      if (!res.ok) return null;
      const body = await res.json() as any;
      const pool = body?.data?.[0];
      if (!pool?.attributes?.address) return null;
      return {
        poolAddress: pool.attributes.address as string,
        symbol: (pool.attributes.name as string | undefined)?.split(' / ')?.[0]?.replace(/^\$/, '') ?? address.slice(0, 8) + '…',
        network,
      };
    } catch { return null; }
  }

  private async fetchDexSearch(query: string): Promise<any[]> {
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`, {
        headers: { 'User-Agent': 'qwai/1.0' },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return [];
      const body = await res.json() as any;
      return body?.pairs ?? [];
    } catch { return []; }
  }

  private async fetchDexTrending(): Promise<any[]> {
    try {
      const res = await fetch('https://api.dexscreener.com/token-boosts/top/v1', {
        headers: { 'User-Agent': 'qwai/1.0' },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return [];
      const body = await res.json() as any;
      return Array.isArray(body) ? body : [];
    } catch { return []; }
  }

  private async checkDexPaid(address: string): Promise<{ paid: boolean; details?: string }> {
    try {
      const res  = await fetch('https://api.dexscreener.com/token-boosts/top/v1', { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) return { paid: false };
      const list = await res.json() as any[];
      const hit  = Array.isArray(list) && list.some((b: any) => b.tokenAddress?.toLowerCase() === address.toLowerCase());
      return { paid: hit, details: hit ? 'Active DexScreener boost' : undefined };
    } catch { return { paid: false }; }
  }

  private async fetchCgGlobal(): Promise<any> {
    const res = await fetch('https://api.coingecko.com/api/v3/global', { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error('CoinGecko unavailable');
    const body = await res.json() as any;
    return body?.data ?? {};
  }

  private async fetchCgMarkets(page: number): Promise<any[]> {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=10&page=${page}&price_change_percentage=24h`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!res.ok) throw new Error('CoinGecko unavailable');
    return res.json() as Promise<any[]>;
  }

  private async fetchCgCoin(query: string): Promise<any | null> {
    const searchRes = await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(5_000) });
    if (!searchRes.ok) return null;
    const searchBody = await searchRes.json() as any;
    const coins: any[] = searchBody?.coins ?? [];
    if (!coins.length) return null;
    const id      = coins[0].id;
    const mktRes  = await fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${id}&price_change_percentage=24h`, { signal: AbortSignal.timeout(5_000) });
    if (!mktRes.ok) return { ...coins[0], id };
    const mkt = await mktRes.json() as any[];
    return mkt[0] ?? { ...coins[0], id };
  }

  private async fetchFearGreed(): Promise<{ value: string; value_classification: string } | null> {
    try {
      const res  = await fetch('https://api.alternative.me/fng/?limit=1', { signal: AbortSignal.timeout(4_000) });
      if (!res.ok) return null;
      const body = await res.json() as any;
      return body?.data?.[0] ?? null;
    } catch { return null; }
  }

  private async fetchEthGas(): Promise<{ slow: number; standard: number; fast: number; instant: number }> {
    try {
      const res = await fetch('https://beaconcha.in/api/v1/execution/gasnow', { signal: AbortSignal.timeout(4_000) });
      if (res.ok) {
        const body = await res.json() as any;
        const d    = body?.data;
        if (d) {
          const gwei = (v: number) => Math.round(v / 1e9);
          return { slow: gwei(d.slow ?? d.standard), standard: gwei(d.standard), fast: gwei(d.fast), instant: gwei(d.rapid ?? d.fast) };
        }
      }
    } catch { /* fallthrough */ }
    const res2 = await fetch('https://ethgas.watch/api/gas', { signal: AbortSignal.timeout(4_000) });
    if (!res2.ok) throw new Error('Gas API unavailable');
    const d2 = await res2.json() as any;
    return { slow: d2.slow?.gwei ?? 0, standard: d2.normal?.gwei ?? 0, fast: d2.fast?.gwei ?? 0, instant: d2.instant?.gwei ?? 0 };
  }

  private async fetchSolanaTopHolders(mint: string): Promise<Array<{ address: string; uiAmount: number }>> {
    const rpc = process.env.HELIUS_RPC_URL ?? process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
    const res = await fetch(rpc, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenLargestAccounts', params: [mint, { commitment: 'confirmed' }] }),
      signal:  AbortSignal.timeout(6_000),
    });
    if (!res.ok) throw new Error('RPC unavailable');
    const body = await res.json() as any;
    return (body?.result?.value ?? []).map((h: any) => ({ address: h.address, uiAmount: h.uiAmount ?? 0 }));
  }

  private async fetchUrlText(url: string): Promise<string | null> {
    try {
      const res  = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QWAI/1.0)' }, signal: AbortSignal.timeout(8_000) });
      if (!res.ok) return null;
      const text = await res.text();
      const ct   = res.headers.get('content-type') ?? '';
      return ct.includes('html') ? text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : text;
    } catch { return null; }
  }

  private formatSocials(data: any): string {
    const info    = data.info ?? {};
    const parts: string[] = [];
    for (const w of (info.websites ?? [])) parts.push(`🌐 <a href="${w.url}">${esc(w.label ?? 'Website')}</a>`);
    for (const s of (info.socials ?? [])) {
      const label = s.type === 'twitter' ? '🐦 Twitter' : s.type === 'telegram' ? '✈️ Telegram' : `🔗 ${esc(s.type)}`;
      parts.push(`${label}: <a href="${s.url}">${esc(s.url.replace(/https?:\/\//, '').slice(0, 40))}</a>`);
    }
    return parts.join('\n');
  }

  /**
   * Resilient socials fetch. Tries DexScreener tokens, DexScreener search, and
   * GeckoTerminal token-info in parallel and merges the results — so /soc
   * succeeds as long as ANY one source has the token, and surfaces socials
   * even when one provider has the website but the other has the twitter.
   */
  private async gatherSocials(address: string): Promise<{
    symbol: string | null;
    chainId: string | null;
    websites: Array<{ url: string; label: string }>;
    socials: Array<{ type: string; url: string }>;
    sources: string[];
  } | null> {
    const chain = detectChain(address);
    // GeckoTerminal needs a specific network slug. We don't know which EVM chain
    // it is from the address alone, so default EVM → ethereum and let the
    // DexScreener providers cover non-eth EVM chains (base, bsc, arbitrum, …).
    const gtNetwork = chain === 'SOLANA' ? 'solana' : 'eth';

    const [dexPair, dexSearch, gtInfo] = await Promise.all([
      this.fetchDexPair(address).catch((e: any) => {
        this.logger.warn(`gatherSocials dex/tokens failed for ${address}: ${e?.message}`);
        return null;
      }),
      this.fetchDexSearch(address).catch((e: any) => {
        this.logger.warn(`gatherSocials dex/search failed for ${address}: ${e?.message}`);
        return [] as any[];
      }),
      this.fetchGeckoTokenInfo(address, gtNetwork).catch((e: any) => {
        this.logger.warn(`gatherSocials gecko/info failed for ${address}: ${e?.message}`);
        return null;
      }),
    ]);

    const websiteMap  = new Map<string, { url: string; label: string }>();
    const socialMap   = new Map<string, { type: string; url: string }>();
    const sources: string[] = [];
    let symbol: string | null = null;
    let chainId: string | null = null;

    const ingestPair = (p: any, source: string) => {
      if (!p) return false;
      let touched = false;
      const info = p.info ?? {};
      for (const w of (info.websites ?? [])) {
        if (!w?.url) continue;
        const key = w.url.toLowerCase();
        if (!websiteMap.has(key)) websiteMap.set(key, { url: w.url, label: w.label ?? 'Website' });
        touched = true;
      }
      for (const s of (info.socials ?? [])) {
        if (!s?.url || !s?.type) continue;
        const key = `${s.type}:${s.url.toLowerCase()}`;
        if (!socialMap.has(key)) socialMap.set(key, { type: s.type, url: s.url });
        touched = true;
      }
      symbol  ??= p.baseToken?.symbol ?? null;
      chainId ??= p.chainId ?? null;
      if (touched && !sources.includes(source)) sources.push(source);
      return touched || !!p.baseToken;
    };

    if (ingestPair(dexPair, 'dexscreener')) { /* counted */ }
    else if (dexPair) { symbol ??= dexPair.baseToken?.symbol ?? null; chainId ??= dexPair.chainId ?? null; if (!sources.includes('dexscreener')) sources.push('dexscreener'); }

    // DexScreener search returns the same pair shape; merge top hits.
    const sortedSearch = [...dexSearch].sort((a, b) => (b?.liquidity?.usd ?? 0) - (a?.liquidity?.usd ?? 0));
    for (const p of sortedSearch.slice(0, 3)) ingestPair(p, 'dexscreener-search');

    if (gtInfo) {
      const a = gtInfo.attributes ?? {};
      symbol  ??= a.symbol ?? null;
      chainId ??= gtNetwork;
      let touched = false;
      for (const url of (a.websites ?? [])) {
        if (!url) continue;
        const key = url.toLowerCase();
        if (!websiteMap.has(key)) websiteMap.set(key, { url, label: 'Website' });
        touched = true;
      }
      const pushHandle = (type: string, handle: string | null | undefined, prefix: string) => {
        if (!handle) return;
        const url = handle.startsWith('http') ? handle : `${prefix}${handle.replace(/^@/, '')}`;
        const key = `${type}:${url.toLowerCase()}`;
        if (!socialMap.has(key)) socialMap.set(key, { type, url });
        touched = true;
      };
      pushHandle('twitter',  a.twitter_handle,  'https://x.com/');
      pushHandle('telegram', a.telegram_handle, 'https://t.me/');
      pushHandle('discord',  a.discord_url,     '');
      pushHandle('farcaster', a.farcaster_url,  '');
      if (touched && !sources.includes('geckoterminal')) sources.push('geckoterminal');
    }

    if (!sources.length) return null;

    return {
      symbol,
      chainId,
      websites: [...websiteMap.values()],
      socials:  [...socialMap.values()],
      sources,
    };
  }

  private async fetchGeckoTokenInfo(address: string, network: string): Promise<any | null> {
    const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'qwai/1.0' };
    const gtKey = process.env.GECKO_TERMINAL_API_KEY;
    if (gtKey) headers['x-cg-demo-api-key'] = gtKey;
    let lastErr: string | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(
          `https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${address}/info`,
          { headers, signal: AbortSignal.timeout(8_000) },
        );
        if (res.status === 404) return null;
        if (res.status === 429) { lastErr = 'GeckoTerminal rate-limited (429)'; }
        else if (res.status >= 500) { lastErr = `GeckoTerminal upstream ${res.status}`; }
        else if (!res.ok) { lastErr = `GeckoTerminal returned ${res.status}`; }
        else {
          const body = await res.json() as any;
          return body?.data ?? null;
        }
      } catch (e: any) {
        lastErr = e?.name === 'TimeoutError' || e?.name === 'AbortError'
          ? 'GeckoTerminal request timed out'
          : `GeckoTerminal fetch failed: ${e?.message ?? 'unknown'}`;
      }
      if (attempt === 1) await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error(lastErr ?? 'GeckoTerminal unreachable');
  }

  private renderSocials(
    websites: Array<{ url: string; label: string }>,
    socials:  Array<{ type: string; url: string }>,
  ): string {
    const parts: string[] = [];
    for (const w of websites) parts.push(`🌐 <a href="${w.url}">${esc(w.label || 'Website')}</a>`);
    const iconFor = (t: string) => {
      const k = t.toLowerCase();
      if (k === 'twitter' || k === 'x') return '🐦 Twitter';
      if (k === 'telegram') return '✈️ Telegram';
      if (k === 'discord')  return '💬 Discord';
      if (k === 'farcaster') return '🟣 Farcaster';
      if (k === 'youtube')  return '▶️ YouTube';
      if (k === 'tiktok')   return '🎵 TikTok';
      if (k === 'github')   return '💻 GitHub';
      if (k === 'medium')   return '📝 Medium';
      if (k === 'reddit')   return '🤖 Reddit';
      if (k === 'instagram') return '📸 Instagram';
      return `🔗 ${esc(t)}`;
    };
    for (const s of socials) {
      const display = s.url.replace(/https?:\/\//, '').replace(/\/$/, '').slice(0, 50);
      parts.push(`${iconFor(s.type)}: <a href="${s.url}">${esc(display)}</a>`);
    }
    return parts.join('\n');
  }

  /**
   * Low-level twitterapi.io search. Returns rich Tweet objects with engagement + author metadata.
   * queryType=Top sorts by engagement (catalyst-hunting); Latest returns reverse-chronological.
   */
  private async searchTweetsTop(query: string, queryType: 'Top' | 'Latest' = 'Top'): Promise<TweetRich[]> {
    const key = process.env.TWITTER_API_IO_KEY;
    if (!key) return [];
    try {
      const res = await fetch(
        `https://api.twitterapi.io/twitter/tweet/advanced_search?query=${encodeURIComponent(query)}&queryType=${queryType}`,
        { headers: { 'X-API-Key': key, Accept: 'application/json' }, signal: AbortSignal.timeout(8_000) },
      );
      if (!res.ok) return [];
      const body = await res.json() as any;
      const raw: any[] = body?.data?.tweets ?? body?.tweets ?? [];
      return raw.map(normalizeTweet).filter((t): t is TweetRich => t != null);
    } catch (e: any) {
      this.logger.warn(`searchTweetsTop failed (${query}): ${e.message}`);
      return [];
    }
  }

  /**
   * Fetches a single tweet by ID via twitterapi.io. Used to honor DexScreener
   * twitter "socials" that point at a specific /status/<id> URL — those are
   * provider-curated catalyst tweets and shouldn't be reduced to just a handle.
   */
  private async fetchTweetById(id: string): Promise<TweetRich | null> {
    const key = process.env.TWITTER_API_IO_KEY;
    if (!key) return null;
    try {
      const res = await fetch(
        `https://api.twitterapi.io/twitter/tweets?tweet_ids=${encodeURIComponent(id)}`,
        { headers: { 'X-API-Key': key, Accept: 'application/json' }, signal: AbortSignal.timeout(6_000) },
      );
      if (!res.ok) return null;
      const body = await res.json() as any;
      const t = (body?.tweets ?? body?.data?.tweets ?? [])[0];
      return t ? normalizeTweet(t) : null;
    } catch (e: any) {
      this.logger.warn(`fetchTweetById(${id}) failed: ${e.message}`);
      return null;
    }
  }

  /**
   * Project handle profile + last tweets — what the token's own account says about itself.
   */
  private async fetchTwitterProfile(handle: string): Promise<{ bio: string; followers: number; lastTweets: string[] } | null> {
    const key = process.env.TWITTER_API_IO_KEY;
    if (!key || !handle) return null;
    const h = { 'X-API-Key': key, Accept: 'application/json' };
    try {
      const [profileRes, tweetsRes] = await Promise.all([
        fetch(`https://api.twitterapi.io/twitter/user/info?userName=${encodeURIComponent(handle)}`,
          { headers: h, signal: AbortSignal.timeout(6_000) }),
        fetch(`https://api.twitterapi.io/twitter/user/last_tweets?userName=${encodeURIComponent(handle)}`,
          { headers: h, signal: AbortSignal.timeout(8_000) }),
      ]);
      const p = profileRes.ok ? (await profileRes.json() as any)?.data : null;
      const tweetsBody = tweetsRes.ok ? await tweetsRes.json() as any : null;
      const lastTweets: string[] = (tweetsBody?.data?.tweets ?? tweetsBody?.tweets ?? [])
        .map((t: any) => (t.text ?? t.full_text ?? '').replace(/https?:\/\/\S+/g, '').trim())
        .filter((t: string) => t.length > 20)
        .slice(0, 8);
      if (!p && !lastTweets.length) return null;
      return {
        bio: (p?.description ?? '').slice(0, 200),
        followers: Number(p?.followers_count ?? p?.followers ?? 0),
        lastTweets,
      };
    } catch (e: any) {
      this.logger.warn(`fetchTwitterProfile @${handle} failed: ${e.message}`);
      return null;
    }
  }

  /**
   * Detects when search results cluster around a shared parent tweet (reply target),
   * then resolves that parent — either by fetching it directly, or by synthesizing
   * a virtual TweetRich from the parent's profile + aggregated reply engagement when
   * the parent has been deleted (a frequent pattern for celebrity meme catalysts).
   *
   * Returns null when no cluster has ≥2 replies (no clear shared catalyst).
   */
  private async reconstructOriginFromReplies(
    searchTweets: TweetRich[],
    seedTweetId: string | null,
    relevanceCtx: {
      sym: string;
      fullName: string;
      addr: string | null;
      projectHandle: string | null;
      narrativeKeywords?: Set<string>;
    },
  ): Promise<TweetRich | null> {
    // Only cluster on RELEVANT replies — without this, common-word tickers
    // (PROG, MOON, AI) would synthesize fake origins from noise tweets that
    // happen to share an unrelated parent (e.g. 5 prog-rock fans replying
    // to some random music tweet).
    const RELEVANCE_FLOOR = 25;
    const relevantTweets = searchTweets.filter(
      t => computeTweetRelevance(t, relevanceCtx) >= RELEVANCE_FLOOR,
    );

    const clusters = new Map<string, { username: string | null; replies: TweetRich[] }>();
    for (const t of relevantTweets) {
      if (!t.inReplyToId) continue;
      if (t.inReplyToId === seedTweetId) continue;
      const c = clusters.get(t.inReplyToId) ?? { username: t.inReplyToUsername, replies: [] };
      if (!c.username && t.inReplyToUsername) c.username = t.inReplyToUsername;
      c.replies.push(t);
      clusters.set(t.inReplyToId, c);
    }

    // Sort by cluster size (more replies = stronger catalyst signal). Min 2 to count.
    const ranked = [...clusters.entries()]
      .filter(([, c]) => c.replies.length >= 2)
      .sort((a, b) => b[1].replies.length - a[1].replies.length);
    const best = ranked[0];
    if (!best) return null;

    const [parentId, { username, replies }] = best;

    // 1. Try to fetch the actual parent. If it exists, use the real thing.
    const fetched = await this.fetchTweetById(parentId);
    if (fetched) return fetched;

    // 2. Parent missing → likely deleted. Synthesize a virtual origin.
    if (!username) return null;
    const profile = await this.fetchTwitterProfile(username).catch(() => null);
    const aggLikes   = replies.reduce((s, r) => s + r.likes, 0);
    const aggReplies = replies.reduce((s, r) => s + r.replies, 0);
    const aggRTs     = replies.reduce((s, r) => s + r.retweets, 0);
    const earliestReplyTs = Math.min(...replies.map(r => r.createdAt));
    // Pull a representative quote from the highest-engagement reply that quotes the catalyst.
    const topReply = [...replies].sort((a, b) => b.likes - a.likes)[0];
    const inferredText = topReply?.text?.slice(0, 200) ?? '';

    return {
      id: parentId,
      text: `(catalyst tweet appears deleted — reconstructed from ${replies.length} reply chains. Inferred content: "${inferredText}")`,
      url: `https://x.com/${username}/status/${parentId}`,
      authorHandle: username,
      authorFollowers: profile?.followers ?? 0,
      authorVerified: false,
      likes: aggLikes,
      retweets: aggRTs,
      replies: aggReplies,
      views: 0,
      // Place virtual origin just before the earliest reply so the ranker treats it as pre-launch.
      createdAt: earliestReplyTs - 60_000,
      inReplyToId: null,
      inReplyToUsername: null,
      isReconstructed: true,
    };
  }

  /**
   * Engagement-aware Twitter lore gatherer. Searches multiple queries in parallel,
   * ranks results to find the catalyst tweet + amplifiers + community vibe, and
   * returns a formatted LLM context block plus clickable source links.
   *
   * Budget tiers (cost ↑ / signal ↑):
   *   light       → 1 Top search on $SYM
   *   balanced    → + name + contract-address searches
   *   aggressive  → + min_faves filter + project-handle profile (default)
   */
  private async gatherLoreFromTwitter(args: {
    sym: string;
    name: string;
    addr: string | null;
    handle: string | null;
    seedTweetId: string | null;
    tokenCreatedAt: number | null;
    budget: LoreBudget;
    /** Authoritative project descriptions (pump.fun, website, CoinGecko) used
     *  to extract the "narrative keyword bag" — boosts tweets that talk about
     *  what the project actually does over price-action shill tweets. */
    descriptionSources?: Array<string | null | undefined>;
  }): Promise<{
    context: string;
    sources: Array<{ label: string; url: string }>;
    highlights: {
      origin: TweetRich | null;
      amplifiers: TweetRich[];
      projectProfile: { handle: string; followers: number; bio: string } | null;
    };
  }> {
    const { sym, name, addr, handle, seedTweetId, tokenCreatedAt, budget, descriptionSources } = args;
    const narrativeKeywords = descriptionSources?.length
      ? extractProjectKeywords(...descriptionSources)
      : undefined;
    // Celebrity / influencer tweets (Elon, Trump, etc.) rarely use the $ prefix —
    // searching the bare ticker is the only way to catch a catalyst tweet that
    // simply mentions the meme by name. We run BOTH $SYM and SYM at every tier.
    const queries: Array<{ q: string; type: 'Top' | 'Latest' }> = [
      { q: `$${sym} -is:retweet`, type: 'Top' },
      { q: `${sym} -is:retweet`,  type: 'Top' },
    ];
    const nameDiffersFromSym = name && name.toUpperCase() !== sym && name.length >= 3;
    if (budget !== 'light') {
      if (addr) queries.push({ q: `${addr} -is:retweet`, type: 'Top' });
      if (nameDiffersFromSym) {
        // Unquoted = AND of words (broader); quoted = exact phrase (sharper).
        // We run both so we don't miss either flavor of catalyst tweet.
        queries.push({ q: `${name} -is:retweet`, type: 'Top' });
        if (/\s/.test(name)) queries.push({ q: `"${name}" -is:retweet`, type: 'Top' });
      }
    }
    if (budget === 'aggressive') {
      queries.push({ q: `$${sym} min_faves:500 -is:retweet`, type: 'Top' });
      queries.push({ q: `${sym} min_faves:1000 -is:retweet`, type: 'Top' });
      if (handle) queries.push({ q: `from:${handle}`, type: 'Latest' });
    }

    const [profile, seedTweet, ...batches] = await Promise.all([
      handle ? this.fetchTwitterProfile(handle) : Promise.resolve(null),
      seedTweetId ? this.fetchTweetById(seedTweetId) : Promise.resolve(null),
      ...queries.map(({ q, type }) => this.searchTweetsTop(q, type)),
    ]);

    const flatSearchTweets = batches.flat();

    // Reply-chain catalyst detection: when N≥2 high-signal tweets reply to the
    // SAME parent, that parent is almost certainly the trigger tweet. Try to
    // fetch it — if the API returns empty, the catalyst was deleted (very common
    // for celebrity meme tweets), so we synthesize a "virtual origin" from the
    // reply cluster and the parent author's profile.
    const reconstructedOrigin = await this.reconstructOriginFromReplies(
      flatSearchTweets,
      seedTweetId,
      { sym, fullName: name, addr, projectHandle: handle, narrativeKeywords },
    );

    const allTweets: TweetRich[] = [
      ...(reconstructedOrigin ? [reconstructedOrigin] : []),
      ...(seedTweet ? [seedTweet] : []),
      ...flatSearchTweets,
    ];
    const { origin, amplifiers, community } = rankTweetsForLore(
      allTweets,
      tokenCreatedAt,
      { sym, fullName: name, addr, projectHandle: handle, narrativeKeywords },
    );

    const lines: string[] = [];
    if (handle && profile) {
      lines.push(`PROJECT ACCOUNT @${handle} (${profile.followers.toLocaleString()} followers):`);
      if (profile.bio) lines.push(`Bio: ${profile.bio}`);
      if (profile.lastTweets.length) {
        lines.push(`Recent tweets from @${handle}:`);
        profile.lastTweets.slice(0, 5).forEach((t, i) => lines.push(`  ${i + 1}. ${t.slice(0, 200)}`));
      }
    }

    if (origin) {
      const reconstructedTag = origin.isReconstructed ? ' [DELETED — reconstructed from reply chain]' : '';
      const engagementSuffix = origin.isReconstructed
        ? `aggregated ${fmtNum(origin.likes)} reply-chain likes`
        : `${fmtNum(origin.likes)} likes, ${fmtNum(origin.retweets)} RTs`;
      lines.push(
        `\nORIGIN TWEET (${new Date(origin.createdAt).toISOString().slice(0, 10)}, @${origin.authorHandle}, ${fmtNum(origin.authorFollowers)} followers, ${engagementSuffix})${reconstructedTag}:`,
        `"${origin.text.slice(0, 320)}"`,
      );
    }
    // Tag each tweet as "project-aligned" (substantial narrative overlap with
    // the project description) or "sentiment" (passes relevance via cashtag/CA
    // but no narrative match). The LLM uses this distinction: project-aligned
    // tweets are evidence for WHAT the project does/means; sentiment tweets
    // are only evidence for COMMUNITY VIBE — never load-bearing on facts.
    const aligned = (t: TweetRich): boolean => {
      if (!narrativeKeywords || narrativeKeywords.size === 0) return false;
      const txt = t.text.toLowerCase();
      let hits = 0;
      for (const k of narrativeKeywords) {
        if (txt.includes(k)) { hits++; if (hits >= 2) return true; }
      }
      return false;
    };
    const tag = (t: TweetRich) => aligned(t) ? ' [project-aligned]' : ' [sentiment-only]';

    if (amplifiers.length) {
      lines.push('\nTOP AMPLIFIERS (engagement-ranked, deduped by author):');
      amplifiers.forEach((t, i) =>
        lines.push(`${i + 1}. @${t.authorHandle}${tag(t)} (${fmtNum(t.authorFollowers)} followers, ${fmtNum(t.likes)} likes): "${t.text.slice(0, 200)}"`),
      );
    }
    if (community.length && budget !== 'light') {
      lines.push('\nCOMMUNITY VIBE:');
      community.forEach((t, i) => lines.push(`${i + 1}. @${t.authorHandle}${tag(t)}: "${t.text.slice(0, 150)}"`));
    }
    if (!origin && !amplifiers.length) {
      lines.push(`\nNO HIGH-ENGAGEMENT TWITTER CATALYST FOUND for $${sym}. Likely organic speculation or too new to have surfaced.`);
    }

    const sources: Array<{ label: string; url: string }> = [];
    if (origin) {
      const label = origin.isReconstructed
        ? `Origin: @${origin.authorHandle} (deleted tweet)`
        : `Origin: @${origin.authorHandle}`;
      sources.push({ label, url: origin.url });
    }
    amplifiers.slice(0, 2).forEach(t => sources.push({ label: `@${t.authorHandle}`, url: t.url }));

    return {
      context: lines.join('\n'),
      sources,
      highlights: {
        origin,
        amplifiers: amplifiers.slice(0, 3),
        projectProfile: handle && profile
          ? { handle, followers: profile.followers, bio: profile.bio }
          : null,
      },
    };
  }
}

/* ── Module-level helpers ────────────────────────────────────────────────── */

/** Engagement-rich tweet shape used by /lore — agnostic to twitterapi.io's field-name drift. */
type TweetRich = {
  id: string;
  text: string;
  url: string;
  authorHandle: string;
  authorFollowers: number;
  authorVerified: boolean;
  likes: number;
  retweets: number;
  replies: number;
  views: number;
  createdAt: number; // ms epoch
  inReplyToId: string | null;
  inReplyToUsername: string | null;
  /** True when this entry was synthesized from a reply-cluster (catalyst was likely deleted). */
  isReconstructed?: boolean;
};

type LoreBudget = 'light' | 'balanced' | 'aggressive';

/**
 * Parse a twitter/x.com URL. Distinguishes profile URLs from tweet permalinks.
 * Examples:
 *   https://x.com/elonmusk            → { handle: 'elonmusk', tweetId: null }
 *   https://x.com/solus1000x/status/2053355503384760779?s=20
 *                                     → { handle: 'solus1000x', tweetId: '2053355503384760779' }
 */
function parseTwitterUrl(url: string): { handle: string | null; tweetId: string | null } {
  const statusMatch = url.match(/(?:twitter|x)\.com\/([^/?#]+)\/status\/(\d+)/);
  if (statusMatch) return { handle: statusMatch[1], tweetId: statusMatch[2] };
  const handleMatch = url.match(/(?:twitter|x)\.com\/([^/?#]+)/);
  return { handle: handleMatch?.[1] ?? null, tweetId: null };
}

/** twitterapi.io returns slightly different field names across endpoints — normalize defensively. */
function normalizeTweet(t: any): TweetRich | null {
  const id = t?.id ?? t?.id_str ?? t?.tweet_id;
  const author = t?.author ?? t?.user ?? {};
  const handle = author?.userName ?? author?.screen_name ?? author?.username;
  if (!id || !handle) return null;
  const text = (t.text ?? t.full_text ?? '').replace(/https?:\/\/\S+/g, '').trim();
  if (text.length < 10) return null;
  const createdRaw = t.createdAt ?? t.created_at;
  const createdAt = createdRaw ? new Date(createdRaw).getTime() : Date.now();
  return {
    id: String(id),
    text,
    url: `https://x.com/${handle}/status/${id}`,
    authorHandle: String(handle),
    authorFollowers: Number(author.followers ?? author.followers_count ?? 0),
    authorVerified: !!(author.isBlueVerified ?? author.verified),
    likes: Number(t.likeCount ?? t.like_count ?? t.favorite_count ?? 0),
    retweets: Number(t.retweetCount ?? t.retweet_count ?? 0),
    replies: Number(t.replyCount ?? t.reply_count ?? 0),
    views: Number(t.viewCount ?? t.view_count ?? 0),
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    inReplyToId: t.inReplyToId || t.in_reply_to_status_id || t.in_reply_to_status_id_str || null,
    inReplyToUsername: t.inReplyToUsername || t.in_reply_to_screen_name || null,
  };
}

/**
 * Picks the origin tweet (oldest with real signal, ideally ≤7d after token launch),
 * top engagement-ranked amplifiers (deduped by author), and remaining community vibe.
 */
/**
 * Score how likely a tweet is actually about THIS token vs. coincidental
 * keyword noise. The fundamental problem: 4-letter tickers like PROG / MOON /
 * BABY / AI collide with common English ("prog rock", "to the moon"), so a bare
 * cashtag/keyword search returns a lot of false positives that LOOK like high
 * engagement but aren't relevant. Without this filter the ranker happily picks
 * a viral prog-rock tweet as the catalyst for $PROG.
 *
 * Strong signals (definitive): CA in tweet text, project-handle authorship,
 * full multi-word project name match.
 * Medium signals: cashtag + crypto context word, reply to project handle.
 * Weak signals: bare ticker alone — explicitly NOT enough to qualify.
 */
const CRYPTO_CONTEXT_RE = /\b(token|coin|pump\.?fun|solana|sol\b|raydium|jupiter|cashtag|ca:|contract|degen|memecoin|liquidity|mcap|market\s*cap|airdrop|launch|chart|dyor|ath)\b/i;

/**
 * Stopwords + crypto-generic terms we strip when building the project's
 * "narrative keyword bag". We don't want "token"/"coin"/"crypto" to count as
 * project-specific themes — they appear in every shill tweet.
 */
const NARRATIVE_STOPWORDS = new Set([
  // English stopwords
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
  'this', 'that', 'these', 'those', 'with', 'from', 'into', 'onto', 'upon', 'about', 'as',
  'at', 'by', 'for', 'in', 'of', 'on', 'to', 'via', 'than', 'then', 'them', 'they', 'their',
  'your', 'you', 'our', 'we', 'us', 'it', 'its', 'his', 'her', 'him', 'she', 'he',
  'not', 'no', 'yes', 'all', 'any', 'each', 'every', 'some', 'such', 'one', 'two',
  // Crypto-generic noise — appears in every memecoin shill
  'token', 'tokens', 'coin', 'coins', 'crypto', 'solana', 'ethereum', 'sol', 'eth',
  'pump', 'pumpfun', 'fun', 'dex', 'cex', 'memecoin', 'meme', 'degen',
  'buy', 'sell', 'hold', 'launch', 'launched', 'launching',
  'chart', 'price', 'market', 'mcap',
]);

/**
 * Extract a bag of "project-specific" keywords from the authoritative project
 * description sources (pump.fun description, CoinGecko description, website
 * text). These keywords let us distinguish tweets that talk about WHAT THE
 * PROJECT DOES from tweets that just shill the ticker for price action.
 *
 * For $PROG, the keyword set will include: autonomous, agent, claims, creator,
 * fees, routes, programmable, strategies, buybacks, burns, payouts, jito —
 * none of which appear in "PROG to the moon 50x bro" sentiment tweets.
 */
function extractProjectKeywords(...sources: (string | null | undefined)[]): Set<string> {
  const bag = new Set<string>();
  for (const src of sources) {
    if (!src) continue;
    const words = src
      .toLowerCase()
      .replace(/<[^>]+>/g, ' ')
      .replace(/https?:\/\/\S+/g, ' ')
      .split(/[^a-z0-9]+/)
      .filter(w => w.length >= 4 && !NARRATIVE_STOPWORDS.has(w));
    for (const w of words) bag.add(w);
  }
  return bag;
}

function computeTweetRelevance(t: TweetRich, ctx: {
  sym: string;
  fullName: string;
  addr: string | null;
  projectHandle: string | null;
  /** Bag of distinctive keywords from the project's own description sources.
   *  When set, tweets that share substantial vocabulary get boosted — this
   *  distinguishes "$PROG automates creator fees" content from "$PROG 50x ape"
   *  content even though both pass the cashtag check. */
  narrativeKeywords?: Set<string>;
}): number {
  const text = t.text.toLowerCase();
  const sym = ctx.sym.toLowerCase();
  const handle = ctx.projectHandle?.toLowerCase() ?? null;
  let r = 0;

  // (A) CA in tweet body — definitive proof it's about this token.
  if (ctx.addr && text.includes(ctx.addr.toLowerCase())) r += 100;

  // (B) $TICKER cashtag.
  const cashtag = new RegExp(`\\$${sym}\\b`, 'i').test(t.text);
  if (cashtag) r += 30;
  // …extra weight when cashtag appears alongside a crypto context word
  // (filters "$prog album drops tonight" type noise from real shill posts).
  if (cashtag && CRYPTO_CONTEXT_RE.test(t.text)) r += 25;

  // (C) Project handle is the author, or the tweet is a reply/quote to them.
  if (handle) {
    if (t.authorHandle.toLowerCase() === handle) r += 50;
    if (text.includes(`@${handle}`)) r += 20;
    if (t.inReplyToUsername?.toLowerCase() === handle) r += 25;
  }

  // (D) Distinctive project name match — requires the words to appear as a
  // CONTIGUOUS phrase (after stripping punctuation/spaces), not just present
  // somewhere in the tweet. Otherwise a generic DeFi term like "Programmable
  // Liquidity" would match unrelated tweets that mention both words apart
  // (e.g. an Arbitrum announcement about "liquidity" and "programmable").
  // Normalization handles the "Bitches, Money, No Taxes, Party" / "Bitches
  // Money No Taxes Party" mismatch from comma-separated reply styles.
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const normText = norm(t.text);
  const normName = norm(ctx.fullName ?? '');
  const nameWords = (ctx.fullName ?? '').split(/\s+/).filter(w => w.length >= 4);
  if (nameWords.length >= 2 && normName.length >= 8 && normText.includes(normName)) {
    r += 40;
  } else if (nameWords.length === 1 && normName.length >= 8 && /[A-Z]/.test(ctx.fullName)) {
    // Long single-word distinctive name (e.g. "EpicSmiley", "BMNTP").
    if (normText.includes(normName)) r += 25;
  }

  // (E) Narrative overlap — how many project-specific keywords does this tweet
  // share with the authoritative project description? This is what separates
  // "$PROG automates creator fees" content (high overlap) from "$PROG 50x ape
  // now 🚀" sentiment content (zero overlap). Sentiment tweets still pass via
  // cashtag scoring but won't rank as the origin/lead amplifier.
  if (ctx.narrativeKeywords && ctx.narrativeKeywords.size > 0) {
    const tweetWords = new Set(
      text
        .replace(/https?:\/\/\S+/g, ' ')
        .split(/[^a-z0-9]+/)
        .filter(w => w.length >= 4 && !NARRATIVE_STOPWORDS.has(w)),
    );
    let overlap = 0;
    for (const k of ctx.narrativeKeywords) {
      if (tweetWords.has(k)) overlap++;
      if (overlap >= 5) break; // diminishing returns past 5 matches
    }
    if (overlap >= 5) r += 50;
    else if (overlap >= 3) r += 30;
    else if (overlap >= 2) r += 15;
  }

  return r;
}

function rankTweetsForLore(
  tweets: TweetRich[],
  tokenCreatedAt: number | null,
  relevanceCtx: {
    sym: string;
    fullName: string;
    addr: string | null;
    projectHandle: string | null;
    narrativeKeywords?: Set<string>;
  },
): { origin: TweetRich | null; amplifiers: TweetRich[]; community: TweetRich[] } {
  const seen = new Set<string>();
  const unique = tweets.filter(t => (seen.has(t.id) ? false : (seen.add(t.id), true)));

  // Score relevance once; reconstructed origins (reply-chain) bypass the filter
  // since their relevance is implicit (we already verified replies cluster).
  const withRelevance = unique.map(t => ({
    t,
    relevance: t.isReconstructed ? 100 : computeTweetRelevance(t, relevanceCtx),
  }));

  // Tweets below the noise floor are excluded — they look engaging but aren't
  // actually about this token. (E.g. viral "prog rock" tweets for $PROG.)
  const ORIGIN_THRESHOLD     = 30;  // must be clearly about this token
  const AMPLIFIER_THRESHOLD  = 25;  // strong signal needed to claim amplification
  const COMMUNITY_THRESHOLD  = 15;  // looser bar for "vibe" mentions

  const score = (t: TweetRich) =>
    t.likes + 2 * t.retweets + 3 * t.replies + Math.log10(Math.max(t.authorFollowers, 1)) * 100;

  const HIGH_ENGAGEMENT = 500;
  const BIG_AUTHOR = 100_000;
  // Catalyst window: a pre-launch tweet within ~90d is the most likely trigger;
  // post-launch tweets within ~7d can also be the spark for fast-following coins.
  const PRELAUNCH_MS  = 90 * 86_400_000;
  const POSTLAUNCH_MS =  7 * 86_400_000;

  const inWindow = (t: TweetRich) =>
    !tokenCreatedAt ||
    (t.createdAt >= tokenCreatedAt - PRELAUNCH_MS && t.createdAt <= tokenCreatedAt + POSTLAUNCH_MS);

  const highSignal = withRelevance
    .filter(({ t, relevance }) => relevance >= ORIGIN_THRESHOLD)
    .map(({ t }) => t)
    .filter(t => t.likes >= HIGH_ENGAGEMENT || t.authorFollowers >= BIG_AUTHOR || t.isReconstructed)
    .filter(inWindow);

  // Prefer pre-launch catalyst (Elon-tweets-first, coin-follows pattern); fall back to post-launch.
  const preLaunch = tokenCreatedAt
    ? highSignal.filter(t => t.createdAt <= tokenCreatedAt).sort((a, b) => score(b) - score(a))
    : [];
  const postLaunchOrAll = highSignal
    .filter(t => !tokenCreatedAt || t.createdAt > tokenCreatedAt)
    .sort((a, b) => score(b) - score(a));
  const origin = preLaunch[0] ?? postLaunchOrAll[0] ?? null;

  const dedupAuthor = new Map<string, TweetRich>();
  const amplifierPool = withRelevance
    .filter(({ relevance }) => relevance >= AMPLIFIER_THRESHOLD)
    .map(({ t }) => t)
    .sort((a, b) => score(b) - score(a));
  for (const t of amplifierPool) {
    if (origin && t.id === origin.id) continue;
    if (!dedupAuthor.has(t.authorHandle)) dedupAuthor.set(t.authorHandle, t);
  }
  const amplifiers = [...dedupAuthor.values()].slice(0, 5);

  const used = new Set<string>([origin?.id, ...amplifiers.map(t => t.id)].filter(Boolean) as string[]);
  const community = withRelevance
    .filter(({ t, relevance }) => relevance >= COMMUNITY_THRESHOLD && !used.has(t.id))
    .map(({ t }) => t)
    .slice(0, 5);

  return { origin, amplifiers, community };
}

function extractAddress(text: string): string | null {
  const evmMatch = text.match(/0x[a-fA-F0-9]{40}/);
  if (evmMatch && detectChain(evmMatch[0])) return evmMatch[0];
  const candidates = text.split(/[^1-9A-HJ-NP-Za-km-z]+/);
  for (const c of candidates) {
    if (c.length >= 32 && c.length <= 44 && detectChain(c)) return c;
  }
  return null;
}

/**
 * Sanitize LLM-emitted HTML so an unexpected tag (e.g. <article>, <area>,
 * <arena>, malformed <a> without href) doesn't crash Telegram's strict HTML
 * parser ("Unsupported start tag ..."). Keeps only the tags Telegram accepts;
 * other angle brackets are HTML-entity-escaped.
 *
 * Reference: https://core.telegram.org/bots/api#html-style
 */
const TG_ALLOWED_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del',
  'code', 'pre', 'blockquote', 'br', 'tg-spoiler',
]);
function sanitizeTelegramHtml(s: string): string {
  return s.replace(/<([^>]*)>/g, (full, inner: string) => {
    const trimmed = inner.trim();
    // Closing tag — keep if whitelisted, otherwise escape.
    if (trimmed.startsWith('/')) {
      const name = trimmed.slice(1).split(/[\s>]/)[0]?.toLowerCase();
      if (name && (TG_ALLOWED_TAGS.has(name) || name === 'a' || name === 'span')) return full;
      return full.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    const nameMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9-]*)/);
    if (!nameMatch) return full.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const name = nameMatch[1].toLowerCase();
    if (TG_ALLOWED_TAGS.has(name)) return full;
    // Anchor tag is allowed only with an href attribute.
    if (name === 'a' && /\bhref\s*=\s*("[^"]+"|'[^']+')/i.test(trimmed)) return full;
    // Spoiler span variant is allowed.
    if (name === 'span' && /class\s*=\s*("|')tg-spoiler\1/i.test(trimmed)) return full;
    return full.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  });
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtUsd(v: number): string {
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(1)}B`;
  if (v >= 1_000_000)     return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)         return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function timeAgo(date: Date): string {
  const secs = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (secs < 60)    return 'just now';
  if (secs < 3600)  return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function fmtNum(v: number): string {
  if (!v || isNaN(v)) return '0';
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + 'M';
  if (v >= 1_000)     return (v / 1_000).toFixed(2) + 'K';
  if (v >= 1)         return v.toFixed(4);
  if (v >= 0.01)      return v.toFixed(6);
  return v.toPrecision(4);
}

function tokenAge(createdAt: number | undefined): string {
  if (!createdAt) return '?';
  const days = Math.floor((Date.now() - createdAt) / 86_400_000);
  if (days === 0)  return 'today';
  if (days < 30)   return `${days}d`;
  if (days < 365)  return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

/* ── Bot command registry (shown in Telegram autocomplete menu) ──────────── */

const BOT_COMMANDS: Array<{ command: string; description: string }> = [
  // Core
  { command: 'start',      description: 'Welcome message & full command list' },
  { command: 'login',      description: 'Link your QWAI account (1-tap magic link)' },
  { command: 'link',       description: 'Link via code: /link <code>' },
  // Scanning
  { command: 'scan',       description: 'Full token scan: /scan <address>' },
  { command: 'z',          description: 'Quick compact scan: /z <address>' },
  { command: 'pf',         description: 'PumpFun scan: /pf <sol_address>' },
  { command: 'ds',         description: 'Search DEX pairs: /ds <name>' },
  { command: 'pfs',        description: 'Search PumpFun tokens: /pfs <name>' },
  { command: 'dp',         description: 'DexPaid check: /dp <address>' },
  { command: 'a',          description: 'CoinGecko lookup: /a <coin_name>' },
  { command: 'soc',        description: 'Find socials: /soc <contract>' },
  { command: 'bsoc',       description: 'Base chain socials: /bsoc <0x_address>' },
  // Charts
  { command: 'c',          description: 'Chart + info: /c <address> [5m|15m|1h|4h|1d]' },
  { command: 'cc',         description: 'Chart link only: /cc <address>' },
  { command: 'cx',         description: 'Minimal chart link: /cx <address>' },
  { command: 'hm',         description: 'Market heatmap links' },
  { command: 'bm',         description: 'Bubblemap: /bm <address>' },
  // Market
  { command: 'macro',      description: 'Market snapshot — MCap, dominance, Fear & Greed' },
  { command: 'index',      description: 'Top coins by MCap: /index [page]' },
  { command: 'gas',        description: 'ETH gas prices (slow/standard/fast)' },
  { command: 'vol',        description: 'Global 24h volume stats' },
  { command: 'dt',         description: 'DEX trending tokens (DexScreener boosted)' },
  { command: 'pft',        description: 'PumpFun trending tokens' },
  { command: 'top',        description: 'Hot tokens right now (AI scored)' },
  // Holders
  { command: 'h',          description: 'Top holders: /h <address>' },
  { command: 'w',          description: 'Wallet scan: /w <wallet_address>' },
  // AI
  { command: 'ask',        description: 'Ask AI anything: /ask <question>' },
  { command: 'tldr',       description: 'Summarize a URL: /tldr <url>' },
  { command: 'lore',       description: 'Token lore / backstory: /lore <address> [light|balanced|aggressive]' },
  { command: 'aica',       description: 'AI contract audit: /aica <address>' },
  // Trading (linked account)
  { command: 'portfolio',  description: 'Your wallets, trades & P&L' },
  { command: 'buy',        description: 'Buy tokens: /buy <amount> <SOL|USDC> <address>' },
  { command: 'sell',       description: 'Sell tokens: /sell <amount> <address>' },
  { command: 'dca',        description: 'DCA bot: /dca <amount> <address> <interval>' },
  { command: 'alerts',     description: 'Recent alerts & notifications' },
  { command: 'kill',       description: 'Emergency stop — pause all agents' },
  { command: 'paper',      description: 'Toggle paper / live trading mode' },
  // Sniper
  { command: 'snipe',      description: 'Sniper bot status & config' },
  { command: 'snipe_on',   description: 'Enable sniper bot' },
  { command: 'snipe_off',  description: 'Disable sniper bot' },
  { command: 'snipe_status', description: 'Sniper session & enabled status' },
  // Group
  { command: 'rank',       description: 'Your XP rank (linked account)' },
  { command: 'gp',         description: 'Leaderboard — most trades' },
  { command: 'ga',         description: 'ATH board — best trades ever' },
  // Tools
  { command: 'bridge',     description: 'Cross-chain bridge links' },
  { command: 'tz',         description: 'World clock — major timezones' },
  { command: 'epoch',      description: 'Convert epoch timestamp: /epoch <ts>' },
  { command: 'remindme',   description: 'Set reminder: /remindme 15m <message>' },
  { command: 'v',          description: 'Value calc: /v <amount> <token>' },
  // Settings
  { command: 'settings',   description: 'Bot settings & dashboard link' },
];

function findSimilarCommands(typed: string): typeof BOT_COMMANDS {
  const lower = typed.toLowerCase();
  // 1. Prefix matches (e.g. "por" → "portfolio")
  const prefix = BOT_COMMANDS.filter(c => c.command.startsWith(lower));
  if (prefix.length) return prefix.slice(0, 3);
  // 2. Substring matches (e.g. "chart" → "c", "cc", "cx")
  const sub = BOT_COMMANDS.filter(c => c.command.includes(lower) || lower.includes(c.command));
  if (sub.length) return sub.slice(0, 3);
  // 3. Levenshtein distance ≤ 2
  return BOT_COMMANDS
    .map(c => ({ ...c, d: levenshtein(lower, c.command) }))
    .filter(c => c.d <= 2)
    .sort((a, b) => a.d - b.d)
    .slice(0, 3);
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
}

const CG_COMMON_IDS: Record<string, string> = {
  btc: 'bitcoin',       bitcoin: 'bitcoin',
  eth: 'ethereum',      ethereum: 'ethereum',
  sol: 'solana',        solana: 'solana',
  bnb: 'binancecoin',
  usdc: 'usd-coin',     usdt: 'tether',
  xrp: 'ripple',
  ada: 'cardano',       cardano: 'cardano',
  avax: 'avalanche-2',  avalanche: 'avalanche-2',
  dot: 'polkadot',      polkadot: 'polkadot',
  link: 'chainlink',    chainlink: 'chainlink',
  matic: 'matic-network', polygon: 'matic-network',
  uni: 'uniswap',       uniswap: 'uniswap',
  atom: 'cosmos',       cosmos: 'cosmos',
  ltc: 'litecoin',      litecoin: 'litecoin',
  doge: 'dogecoin',     dogecoin: 'dogecoin',
  shib: 'shiba-inu',
  pepe: 'pepe',
  bonk: 'bonk',
  wif: 'dogwifcoin',
  jup: 'jupiter-exchange-solana',
  sui: 'sui',
  apt: 'aptos',
  op: 'optimism',       optimism: 'optimism',
  arb: 'arbitrum',      arbitrum: 'arbitrum',
};
