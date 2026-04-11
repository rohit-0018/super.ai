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
  const data = await post<{ reply?: string }>(
    '/chat/telegram',
    { content },
    { 'X-Telegram-Id': String(chatId) },
  );
  return data?.reply ?? '…';
}

function registerHandlers(bot: Bot) {
  bot.command('start', (ctx) =>
    ctx.reply(
      [
        '👋 I am QWAI — your personal AI trading agent.',
        '',
        'To share memory + wallets with your web dashboard:',
        '1. Open web dashboard → Settings → "Link Telegram"',
        '2. Send me `/link <code>` here',
        '',
        'Then just talk to me naturally: "Buy $200 of SOL", "How is my portfolio?", etc.',
      ].join('\n'),
      {
        reply_markup: new InlineKeyboard().text('📊 Portfolio', 'portfolio').text('⚠️ Kill switch', 'kill'),
      },
    ),
  );

  bot.command('link', async (ctx) => {
    const code = ctx.match?.trim();
    if (!code) {
      return ctx.reply('Usage: `/link <code>` — generate a code from web dashboard Settings.', {
        parse_mode: 'Markdown',
      });
    }
    try {
      await post('/auth/telegram/link', { code, telegramChatId: String(ctx.chat.id) });
      return ctx.reply('✅ Telegram linked. You now share memory with the web dashboard.');
    } catch (e: any) {
      const msg = (e instanceof HttpError && (e.body as any)?.message) || e?.message || 'unknown error';
      return ctx.reply(`❌ Link failed: ${msg}`);
    }
  });

  bot.command('portfolio', async (ctx) => {
    try {
      const reply = await chat(ctx.chat.id, 'Give me my portfolio summary.');
      return ctx.reply(reply);
    } catch (e: any) {
      return ctx.reply(`Error: ${e.message}`);
    }
  });

  bot.command('paper', async (ctx) =>
    ctx.reply('Paper trading toggle lives on the web /settings page — flip it there to stay in sync.'),
  );

  bot.command('kill', async (ctx) => {
    try {
      const reply = await chat(ctx.chat.id, 'Engage kill switch immediately. Pause all agents.');
      return ctx.reply(`🚨 ${reply}`);
    } catch (e: any) {
      return ctx.reply(`Error: ${e.message}`);
    }
  });

  bot.on('message:text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) return;
    try {
      const reply = await chat(ctx.chat.id, ctx.message.text);
      return ctx.reply(reply);
    } catch (e: any) {
      return ctx.reply('Error talking to QWAI: ' + e.message);
    }
  });

  bot.callbackQuery('portfolio', async (ctx) => {
    await ctx.answerCallbackQuery();
    return ctx.reply('Use /portfolio to get your current positions.');
  });

  bot.callbackQuery('kill', async (ctx) => {
    await ctx.answerCallbackQuery();
    return ctx.reply('Use /kill to engage the kill switch.');
  });
}

if (!token) {
  console.warn('[qwai-bot] TELEGRAM_BOT_TOKEN missing — bot is idle. Set the env var to enable.');
  setInterval(() => {}, 1 << 30);
} else {
  const bot = new Bot(token);
  registerHandlers(bot);
  bot.start();
  console.log(`QWAI Telegram bot running — API ${apiBase}`);
}
