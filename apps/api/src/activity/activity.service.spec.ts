import { ActivityService } from './activity.service';

function makePrisma(orders: any[] = [], trades: any[] = []) {
  return {
    order: {
      findMany: jest.fn().mockImplementation(({ where, take }: any) => {
        let rows = orders.filter((o) => o.userId === where.userId);
        if (where.source) rows = rows.filter((o) => o.source === where.source);
        if (where.status) rows = rows.filter((o) => o.status === where.status);
        if (where.chain) rows = rows.filter((o) => o.chain === where.chain);
        rows.sort((a, b) => +b.createdAt - +a.createdAt);
        return Promise.resolve(rows.slice(0, take));
      }),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    trade: {
      findMany: jest.fn().mockImplementation(({ where, take }: any) => {
        let rows = trades.filter((t) => t.userId === where.userId);
        if (where.source) rows = rows.filter((t) => t.source === where.source);
        if (where.side) rows = rows.filter((t) => t.side === where.side);
        if (where.chain) rows = rows.filter((t) => t.chain === where.chain);
        if (where.mode) rows = rows.filter((t) => t.mode === where.mode);
        rows.sort((a, b) => +b.createdAt - +a.createdAt);
        return Promise.resolve(rows.slice(0, take));
      }),
      groupBy: jest.fn().mockResolvedValue([]),
    },
  } as any;
}

const u = 'user1';

const order1 = {
  id: 'o1',
  userId: u,
  walletId: 'w1',
  type: 'MARKET',
  status: 'FILLED',
  chain: 'SOLANA',
  tokenIn: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  tokenOut: 'So11111111111111111111111111111111111111112',
  amountIn: '200',
  params: { notionalUsd: 200 },
  txHash: '5xRealSig',
  source: 'WEB',
  createdAt: new Date('2026-04-15T10:00:00Z'),
  updatedAt: new Date('2026-04-15T10:00:00Z'),
};

const trade1 = {
  id: 't1',
  orderId: null,
  userId: u,
  side: 'buy',
  chain: 'SOLANA',
  tokenIn: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  tokenOut: 'MEME',
  amountIn: '100',
  amountOut: '95',
  priceUsd: 100,
  pnlUsd: null,
  mode: 'LIVE',
  txHash: 'sigA',
  source: 'CHAT',
  createdAt: new Date('2026-04-15T11:00:00Z'),
};

const tradePaper = {
  ...trade1,
  id: 't2',
  mode: 'PAPER',
  txHash: 'paper-abc',
  source: 'WEB',
  createdAt: new Date('2026-04-15T12:00:00Z'),
};

const tradeTestnetSim = {
  ...trade1,
  id: 't3',
  txHash: 'testnet-sim-deadbeef',
  source: 'TELEGRAM',
  createdAt: new Date('2026-04-15T13:00:00Z'),
};

describe('ActivityService', () => {
  it('merges orders and trades into one chronologically sorted feed', async () => {
    const prisma = makePrisma([order1], [trade1, tradePaper, tradeTestnetSim]);
    const svc = new ActivityService(prisma);
    const items = await svc.list(u);
    expect(items.length).toBe(4);
    // Most recent first
    expect(items[0].id).toBe('trade:t3');
    expect(items[1].id).toBe('trade:t2');
    expect(items[2].id).toBe('trade:t1');
    expect(items[3].id).toBe('order:o1');
  });

  it('marks paper-* and testnet-sim-* hashes as simulated, and they have no explorer URL', async () => {
    const prisma = makePrisma([], [tradePaper, tradeTestnetSim]);
    const svc = new ActivityService(prisma);
    const items = await svc.list(u);
    const paper = items.find((i) => i.id === 'trade:t2')!;
    const sim = items.find((i) => i.id === 'trade:t3')!;
    expect(paper.simulated).toBe(true);
    expect(paper.explorerUrl).toBeNull();
    expect(paper.status).toBe('SIMULATED');
    expect(sim.simulated).toBe(true);
    expect(sim.explorerUrl).toBeNull();
  });

  it('real on-chain trades get a Solscan explorer URL', async () => {
    const prisma = makePrisma([], [trade1]);
    const svc = new ActivityService(prisma);
    const [item] = await svc.list(u);
    expect(item.simulated).toBe(false);
    expect(item.explorerUrl).toMatch(/solscan\.io\/tx\//);
    expect(item.status).toBe('EXECUTED');
  });

  it('filters by source', async () => {
    const prisma = makePrisma([order1], [trade1, tradePaper, tradeTestnetSim]);
    const svc = new ActivityService(prisma);
    const items = await svc.list(u, { source: 'TELEGRAM' });
    expect(items.length).toBe(1);
    expect(items[0].source).toBe('TELEGRAM');
  });

  it('filters by kind=ORDER and kind=TRADE', async () => {
    const prisma = makePrisma([order1], [trade1, tradePaper]);
    const svc = new ActivityService(prisma);
    const orders = await svc.list(u, { kind: 'ORDER' });
    const trades = await svc.list(u, { kind: 'TRADE' });
    expect(orders.length).toBe(1);
    expect(orders[0].kind).toBe('ORDER');
    expect(trades.length).toBe(2);
    expect(trades.every((t) => t.kind === 'TRADE')).toBe(true);
  });

  it('filters by side=buy', async () => {
    const sellTrade = { ...trade1, id: 't-sell', side: 'sell', source: 'AGENT' };
    const prisma = makePrisma([], [trade1, sellTrade]);
    const svc = new ActivityService(prisma);
    const buys = await svc.list(u, { side: 'buy' });
    expect(buys.length).toBe(1);
    expect(buys[0].side).toBe('buy');
  });

  it('search matches token addresses and tx hash', async () => {
    const prisma = makePrisma([], [trade1, tradePaper, tradeTestnetSim]);
    const svc = new ActivityService(prisma);
    const byHash = await svc.list(u, { search: 'paper-abc' });
    expect(byHash.length).toBe(1);
    expect(byHash[0].txHash).toBe('paper-abc');

    const byToken = await svc.list(u, { search: 'meme' });
    expect(byToken.length).toBe(3); // all three trades have MEME as tokenOut
  });
});
