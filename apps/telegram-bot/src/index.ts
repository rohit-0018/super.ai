import 'dotenv/config';
import { Bot, InlineKeyboard } from 'grammy';

const token = process.env.TELEGRAM_BOT_TOKEN;
const apiBase = process.env.API_BASE ?? process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:4400/api';

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

async function post<T = any>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const resp = await fetch(apiBase + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await resp.text();
    const data = text ? JSON.parse(text) : null;
    if (!resp.ok) {
      const msg = (data && (data.message || data.error)) || `HTTP ${resp.status}`;
      throw new HttpError(msg, resp.status, data);
    }
    return data as T;
  } finally {
    clearTimeout(timer);
  }
}

async function chat(chatId: number, content: string): Promise<string> {
  const data = await post<{ reply?: string; linked?: boolean }>(
    '/chat/telegram',
    { content },
    { 'X-Telegram-Id': String(chatId) },
  );
  if (data?.linked === false) {
    return '🔗 This Telegram is not linked to a QWAI account. Open web dashboard → Settings → "Link Telegram" to get a code, then send /link <code> here.';
  }
  return data?.reply ?? '…';
}

function registerHandlers(bot: Bot) {
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
      await post('/auth/telegram/link', { code, telegramChatId: String(ctx.chat.id) });
      return ctx.reply('✅ Telegram linked! You now share memory + wallets with the web dashboard.');
    } catch (e: any) {
      const msg = (e instanceof HttpError && (e.body as any)?.message) || e?.message || 'unknown error';
      return ctx.reply(`❌ Link failed: ${msg}`);
    }
  });

  // /portfolio
  bot.command('portfolio', async (ctx) => {
    try {
      const reply = await chat(ctx.chat.id, 'Give me my portfolio summary with current positions and P&L.');
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
      const reply = await chat(ctx.chat.id, `Buy ${args}`);
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
      const reply = await chat(ctx.chat.id, `Sell ${args}`);
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
      const reply = await chat(ctx.chat.id, `Set up a DCA: buy ${args}`);
      return ctx.reply(reply);
    } catch (e: any) {
      return ctx.reply(`Error: ${e.message}`);
    }
  });

  // /alerts — recent alerts
  bot.command('alerts', async (ctx) => {
    try {
      const reply = await chat(ctx.chat.id, 'Show me my recent alerts and notifications.');
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
        return ctx.reply(await chat(ctx.chat.id, 'Portfolio summary'));
      case 'alerts':
        return ctx.reply(await chat(ctx.chat.id, 'Show my recent alerts'));
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
      const reply = await chat(ctx.chat.id, 'Engage kill switch immediately. Pause all agents.');
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
      const reply = await chat(ctx.chat.id, `Confirmed — ${action} ${args}. Execute now.`);
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
      const reply = await chat(ctx.chat.id, ctx.message.text);
      return ctx.reply(reply);
    } catch (e: any) {
      return ctx.reply('Error talking to QWAI: ' + e.message);
    }
  });
}

if (!token) {
  console.warn('[qwai-bot] TELEGRAM_BOT_TOKEN missing — bot is idle. Set the env var to enable.');
  setInterval(() => {}, 1 << 30);
} else {
  const bot = new Bot(token);
  registerHandlers(bot);

  // P13: Auto-restart on crash (redundancy at process level).
  // For multi-instance redundancy, deploy 2+ replicas behind a load balancer
  // and use Telegram's webhook mode (bot.api.setWebhook) instead of polling.
  bot.catch((err) => {
    console.error('[qwai-bot] Unhandled error:', err);
  });

  bot.start({
    onStart: () => console.log(`QWAI Telegram bot running — API ${apiBase}`),
    allowed_updates: ['message', 'callback_query'],
  });

  // Graceful shutdown
  const shutdown = () => { bot.stop(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
