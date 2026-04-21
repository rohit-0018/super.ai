// QWAI deterministic seed. Idempotent: safe to re-run on every deploy.
// Creates a demo user + wallet + realistic trade/order/agent/alert history so a
// freshly deployed instance shows non-empty dashboards during smoke tests.
import { PrismaClient, Chain, OrderStatus, OrderType, TradeMode, AgentKind, AgentStatus, AlertSeverity } from '@prisma/client';

const prisma = new PrismaClient();

const DEMO_USER_ID = 'cmnum5z6z0000dxmdronja7ic';
const DEMO_WALLET_ID = 'cmnup89d40003d9khj1mww076';
const DEMO_EMAIL = 'demo@qwai.local';
const DEMO_WALLET_ADDRESS = 'DemoSolWallet111111111111111111111111111111';

async function ago(hours: number) {
  return new Date(Date.now() - hours * 3600_000);
}

async function main() {
  console.log('▶ seeding demo user', DEMO_USER_ID);
  await prisma.user.upsert({
    where: { id: DEMO_USER_ID },
    update: {},
    create: {
      id: DEMO_USER_ID,
      email: DEMO_EMAIL,
      primaryWallet: DEMO_WALLET_ADDRESS,
      paperMode: true,
      riskProfile: { tolerance: 'medium' },
      notificationPrefs: { telegram: true, email: true, discord: false },
    },
  });

  await prisma.wallet.upsert({
    where: { id: DEMO_WALLET_ID },
    update: {},
    create: {
      id: DEMO_WALLET_ID,
      userId: DEMO_USER_ID,
      chain: Chain.SOLANA,
      address: DEMO_WALLET_ADDRESS,
      encryptedKey: 'demo:not-a-real-key',
      encryptedDek: 'demo:not-a-real-dek',
      label: 'Demo',
      isPrimary: true,
    },
  });

  await prisma.guardrailConfig.upsert({
    where: { userId: DEMO_USER_ID },
    update: { perTradeUsd: 500, dailyUsd: 2000, maxSlippageBps: 150 },
    create: {
      userId: DEMO_USER_ID,
      perTradeUsd: 500,
      dailyUsd: 2000,
      maxSlippageBps: 150,
      whitelist: [],
      blacklist: [],
      killSwitch: false,
    },
  });

  await prisma.tradingDna.upsert({
    where: { userId: DEMO_USER_ID },
    update: { winRate: 0.58, totalTrades: 12, avgHoldMinutes: 480, riskScore: 6.2 },
    create: {
      userId: DEMO_USER_ID,
      winRate: 0.58,
      totalTrades: 12,
      avgHoldMinutes: 480,
      riskScore: 6.2,
      behavioralSignals: { avgTradesPerDay: 3.2, tradingHours: '09:00-22:00', emotionalTriggers: 1 },
      preferences: { preferredChain: 'SOLANA', favoriteTokens: ['SOL', 'JUP', 'BONK'], riskTolerance: 'medium' },
    },
  });

  const trades: Array<Parameters<typeof prisma.trade.upsert>[0]['create']> = [
    { id: 't-seed-01', userId: DEMO_USER_ID, chain: Chain.SOLANA, side: 'buy',  tokenIn: 'USDC', tokenOut: 'SOL',  amountIn: '200',     amountOut: '1.42',    priceUsd: 142.00, mode: TradeMode.PAPER, txHash: 'paper-seed-01', createdAt: await ago(144) },
    { id: 't-seed-02', userId: DEMO_USER_ID, chain: Chain.SOLANA, side: 'buy',  tokenIn: 'USDC', tokenOut: 'SOL',  amountIn: '100',     amountOut: '0.71',    priceUsd: 141.50, mode: TradeMode.PAPER, txHash: 'paper-seed-02', createdAt: await ago(120) },
    { id: 't-seed-03', userId: DEMO_USER_ID, chain: Chain.SOLANA, side: 'sell', tokenIn: 'SOL',  tokenOut: 'USDC', amountIn: '0.71',    amountOut: '103.2',   priceUsd: 145.35, pnlUsd: 3.20,  mode: TradeMode.PAPER, txHash: 'paper-seed-03', createdAt: await ago(96) },
    { id: 't-seed-04', userId: DEMO_USER_ID, chain: Chain.SOLANA, side: 'buy',  tokenIn: 'USDC', tokenOut: 'BONK', amountIn: '50',      amountOut: '2500000', priceUsd: 0,     mode: TradeMode.PAPER, txHash: 'paper-seed-04', createdAt: await ago(72) },
    { id: 't-seed-05', userId: DEMO_USER_ID, chain: Chain.SOLANA, side: 'sell', tokenIn: 'BONK', tokenOut: 'USDC', amountIn: '2500000', amountOut: '58',      priceUsd: 0,     pnlUsd: 8.00,  mode: TradeMode.PAPER, txHash: 'paper-seed-05', createdAt: await ago(70) },
    { id: 't-seed-06', userId: DEMO_USER_ID, chain: Chain.SOLANA, side: 'buy',  tokenIn: 'USDC', tokenOut: 'SOL',  amountIn: '150',     amountOut: '1.05',    priceUsd: 142.86, mode: TradeMode.PAPER, txHash: 'paper-seed-06', createdAt: await ago(48) },
    { id: 't-seed-07', userId: DEMO_USER_ID, chain: Chain.SOLANA, side: 'sell', tokenIn: 'SOL',  tokenOut: 'USDC', amountIn: '1.42',    amountOut: '210.5',   priceUsd: 148.24, pnlUsd: 10.50, mode: TradeMode.PAPER, txHash: 'paper-seed-07', createdAt: await ago(24) },
    { id: 't-seed-08', userId: DEMO_USER_ID, chain: Chain.EVM,    side: 'buy',  tokenIn: 'USDC', tokenOut: 'ETH',  amountIn: '500',     amountOut: '0.2',     priceUsd: 2500,  mode: TradeMode.PAPER, txHash: 'paper-seed-08', createdAt: await ago(21) },
    { id: 't-seed-09', userId: DEMO_USER_ID, chain: Chain.SOLANA, side: 'buy',  tokenIn: 'USDC', tokenOut: 'JUP',  amountIn: '75',      amountOut: '100',     priceUsd: 0.75,  mode: TradeMode.PAPER, txHash: 'paper-seed-09', createdAt: await ago(12) },
    { id: 't-seed-10', userId: DEMO_USER_ID, chain: Chain.SOLANA, side: 'sell', tokenIn: 'JUP',  tokenOut: 'USDC', amountIn: '100',     amountOut: '82',      priceUsd: 0.82,  pnlUsd: 7.00,  mode: TradeMode.PAPER, txHash: 'paper-seed-10', createdAt: await ago(6) },
    { id: 't-seed-11', userId: DEMO_USER_ID, chain: Chain.SOLANA, side: 'sell', tokenIn: 'SOL',  tokenOut: 'USDC', amountIn: '1.05',    amountOut: '155.2',   priceUsd: 147.81, pnlUsd: 5.20,  mode: TradeMode.PAPER, txHash: 'paper-seed-11', createdAt: await ago(3) },
    { id: 't-seed-12', userId: DEMO_USER_ID, chain: Chain.EVM,    side: 'sell', tokenIn: 'ETH',  tokenOut: 'USDC', amountIn: '0.2',     amountOut: '515',     priceUsd: 2575,  pnlUsd: 15.00, mode: TradeMode.PAPER, txHash: 'paper-seed-12', createdAt: await ago(1) },
  ];
  for (const t of trades) {
    await prisma.trade.upsert({ where: { id: t.id! }, update: {}, create: t });
  }

  const orders: Array<Parameters<typeof prisma.order.upsert>[0]['create']> = [
    { id: 'o-seed-01', userId: DEMO_USER_ID, walletId: DEMO_WALLET_ID, type: OrderType.STOP_LOSS,     status: OrderStatus.ACTIVE, chain: Chain.SOLANA, tokenIn: 'SOL',  tokenOut: 'USDC', amountIn: '1.0', params: { stopPrice: 130 } },
    { id: 'o-seed-02', userId: DEMO_USER_ID, walletId: DEMO_WALLET_ID, type: OrderType.TAKE_PROFIT,   status: OrderStatus.ACTIVE, chain: Chain.SOLANA, tokenIn: 'SOL',  tokenOut: 'USDC', amountIn: '1.0', params: { takeProfit: 160 } },
    { id: 'o-seed-03', userId: DEMO_USER_ID, walletId: DEMO_WALLET_ID, type: OrderType.TRAILING_STOP, status: OrderStatus.ACTIVE, chain: Chain.SOLANA, tokenIn: 'SOL',  tokenOut: 'USDC', amountIn: '0.5', params: { trailBps: 500, trailPeak: 148 } },
    { id: 'o-seed-04', userId: DEMO_USER_ID, walletId: DEMO_WALLET_ID, type: OrderType.LIMIT,         status: OrderStatus.ACTIVE, chain: Chain.SOLANA, tokenIn: 'USDC', tokenOut: 'SOL',  amountIn: '200', params: { stopPrice: 125 } },
    { id: 'o-seed-05', userId: DEMO_USER_ID, walletId: DEMO_WALLET_ID, type: OrderType.MARKET,        status: OrderStatus.FILLED, chain: Chain.SOLANA, tokenIn: 'USDC', tokenOut: 'SOL',  amountIn: '200', params: {} },
    { id: 'o-seed-06', userId: DEMO_USER_ID, walletId: DEMO_WALLET_ID, type: OrderType.MARKET,        status: OrderStatus.FILLED, chain: Chain.SOLANA, tokenIn: 'SOL',  tokenOut: 'USDC', amountIn: '0.71', params: {} },
  ];
  for (const o of orders) {
    await prisma.order.upsert({ where: { id: o.id! }, update: {}, create: o });
  }

  const agents: Array<Parameters<typeof prisma.agent.upsert>[0]['create']> = [
    { id: 'a-seed-01', userId: DEMO_USER_ID, kind: AgentKind.DCA,              status: AgentStatus.RUNNING, params: { walletId: DEMO_WALLET_ID, chain: 'SOLANA', tokenIn: 'USDC', tokenOut: 'SOL', amountUsd: 25, interval: 'daily', slippageBps: 100 }, lastRunAt: await ago(0.5) },
    { id: 'a-seed-02', userId: DEMO_USER_ID, kind: AgentKind.STOP_LOSS,        status: AgentStatus.RUNNING, params: { symbol: 'SOL', stopPrice: 130 }, lastRunAt: await ago(0.03) },
    { id: 'a-seed-03', userId: DEMO_USER_ID, kind: AgentKind.POSITION_MONITOR, status: AgentStatus.RUNNING, params: { tokens: ['SOL', 'ETH', 'JUP'] }, lastRunAt: await ago(0.008) },
    { id: 'a-seed-04', userId: DEMO_USER_ID, kind: AgentKind.COPY_TRADE,       status: AgentStatus.PAUSED,  params: { srcWallet: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin' } },
    { id: 'a-seed-05', userId: DEMO_USER_ID, kind: AgentKind.BRIEFING,         status: AgentStatus.RUNNING, params: { schedule: '08:00', tz: 'Asia/Kolkata' }, lastRunAt: await ago(14) },
  ];
  for (const a of agents) {
    await prisma.agent.upsert({ where: { id: a.id! }, update: {}, create: a });
  }

  const balances = [
    { id: 'pb-seed-01', userId: DEMO_USER_ID, token: 'SOL',  amount: '2.47' },
    { id: 'pb-seed-02', userId: DEMO_USER_ID, token: 'USDC', amount: '823.50' },
    { id: 'pb-seed-03', userId: DEMO_USER_ID, token: 'ETH',  amount: '0.2' },
  ];
  for (const b of balances) {
    await prisma.paperBalance.upsert({ where: { userId_token: { userId: b.userId, token: b.token } }, update: { amount: b.amount }, create: b });
  }

  const alerts: Array<Parameters<typeof prisma.alertEvent.upsert>[0]['create']> = [
    { id: 'al-seed-01', userId: DEMO_USER_ID, kind: 'BRIEFING',           severity: AlertSeverity.INFO,     payload: { window: '24h', tradesCount: 5, filledOrders: 3, alertsCount: 2, pnlUsd: 28.70, volumeUsd: 1075, summary: '3 of 5 orders filled overnight. Portfolio up $28.70. DCA bought SOL at $142.' }, deliveredAt: await ago(6) },
    { id: 'al-seed-02', userId: DEMO_USER_ID, kind: 'ORDER_TRIGGERED',    severity: AlertSeverity.INFO,     payload: { orderId: 'o-seed-05', type: 'SELL', price: 148.24, reason: 'Take-profit on SOL', message: 'Sold 1.42 SOL at $148.24 — P&L +$10.50' }, deliveredAt: await ago(24) },
    { id: 'al-seed-03', userId: DEMO_USER_ID, kind: 'GUARDRAIL_BLOCKED',  severity: AlertSeverity.WARN,     payload: { reason: 'PER_TRADE_LIMIT_$500', message: 'Blocked a $750 trade — per-trade cap is $500.' }, deliveredAt: await ago(48) },
    { id: 'al-seed-04', userId: DEMO_USER_ID, kind: 'RUG_FLAG',           severity: AlertSeverity.CRITICAL, payload: { token: 'FakeToken123', flags: ['MINT_NOT_RENOUNCED', 'HIGH_TAX'], message: 'Token flagged by GoPlus: mint authority active + 15% hidden tax. Blocked.' }, deliveredAt: await ago(72) },
    { id: 'al-seed-05', userId: DEMO_USER_ID, kind: 'EMOTIONAL_NUDGE',    severity: AlertSeverity.WARN,     payload: { triggers: ['HIGH_FREQUENCY'], message: '7 trades in the last hour — possible FOMO. Consider paper mode.' }, deliveredAt: await ago(96) },
  ];
  for (const a of alerts) {
    await prisma.alertEvent.upsert({ where: { id: a.id! }, update: {}, create: a });
  }

  const priceAlerts = [
    { id: 'pa-seed-01', userId: DEMO_USER_ID, token: 'SOL', chain: Chain.SOLANA, targetUsd: 160.00, direction: 'above', fired: false },
    { id: 'pa-seed-02', userId: DEMO_USER_ID, token: 'SOL', chain: Chain.SOLANA, targetUsd: 125.00, direction: 'below', fired: false },
    { id: 'pa-seed-03', userId: DEMO_USER_ID, token: 'ETH', chain: Chain.EVM,    targetUsd: 3001.0, direction: 'above', fired: false },
  ];
  for (const pa of priceAlerts) {
    await prisma.priceAlert.upsert({ where: { id: pa.id }, update: {}, create: pa });
  }

  const messages = [
    { id: 'msg-seed-01', userId: DEMO_USER_ID, role: 'user',      content: 'Buy $200 of SOL',                                           channel: 'web', createdAt: await ago(144) },
    { id: 'msg-seed-02', userId: DEMO_USER_ID, role: 'assistant', content: 'Bought 1.42 SOL at $142. Trade ID: t-seed-01. Mode: PAPER.', channel: 'web', createdAt: await ago(143.99) },
    { id: 'msg-seed-03', userId: DEMO_USER_ID, role: 'user',      content: 'Set a stop-loss at $130',                                   channel: 'web', createdAt: await ago(120) },
    { id: 'msg-seed-04', userId: DEMO_USER_ID, role: 'assistant', content: 'Stop-loss set. Order o-seed-01 watching SOL at $130.',       channel: 'web', createdAt: await ago(119.99) },
  ];
  for (const m of messages) {
    await prisma.conversationMessage.upsert({ where: { id: m.id }, update: {}, create: m });
  }

  console.log('✔ seed complete');
}

main()
  .catch((e) => {
    console.error('✗ seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
