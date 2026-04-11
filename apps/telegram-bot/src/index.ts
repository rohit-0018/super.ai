import 'dotenv/config';
import { Bot, InlineKeyboard } from 'grammy';
import axios from 'axios';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) { console.error('TELEGRAM_BOT_TOKEN missing'); process.exit(1); }

const api = axios.create({ baseURL: process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:4000/api' });
const bot = new Bot(token);

bot.command('start', (ctx) => ctx.reply(
  'Hi — I am QWAI, your personal AI trading agent. I share memory with your web dashboard.\n\nTry: "Buy $200 of SOL" or /portfolio',
  { reply_markup: new InlineKeyboard().text('📊 Portfolio', 'portfolio').text('💰 Trade', 'trade') },
));

bot.command('portfolio', async (ctx) => {
  // calls API with the user's linked JWT (linking flow stores telegramId → userId in unified-session table)
  ctx.reply('Portfolio: (linked via /link <code> from web dashboard)');
});

bot.command('paper', async (ctx) => ctx.reply('Paper trading mode toggle — visit web /settings to flip.'));
bot.command('kill', async (ctx) => ctx.reply('🚨 Sending kill switch request to API…'));

bot.on('message:text', async (ctx) => {
  try {
    const { data } = await api.post('/chat', { content: ctx.message.text }, {
      headers: { 'X-Telegram-Id': String(ctx.from?.id) },
      responseType: 'text',
    });
    ctx.reply(typeof data === 'string' ? data : JSON.stringify(data));
  } catch (e: any) {
    ctx.reply('Error talking to QWAI brain: ' + e.message);
  }
});

bot.start();
console.log('QWAI Telegram bot running');
