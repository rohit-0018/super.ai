import { ExitEngineService } from './exit-engine.service';

// Mock the BullMQ queue layer so learning-ingest enqueues don't touch Redis.
jest.mock('../agents/queues', () => ({
  makeQueue: jest.fn(() => ({ add: jest.fn().mockResolvedValue(undefined) })),
  makeJobData: jest.fn((d: any) => d),
  QUEUES: { LEARNING_INGEST: 'learning-ingest' },
}));

const SOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Builds an ExitEngineService with controllable mocks. `swap` defaults to a
 * successful confirmed sell; pass `swap` to override (e.g. reject to simulate a
 * failed/unconfirmed sell).
 */
function makeService(opts: {
  swap?: jest.Mock;
  wallet?: any;
  live?: { marketCapUsd: number; priceUsd: number } | null;
} = {}) {
  const updates: any[] = [];

  const prisma: any = {
    trade: {
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn((args: any) => { updates.push(args.data); return Promise.resolve({}); }),
    },
    wallet: {
      findFirst: jest.fn().mockResolvedValue(
        'wallet' in opts ? opts.wallet : { id: 'w1', userId: 'u1', chain: 'SOLANA' },
      ),
    },
    verdictHistory: { findFirst: jest.fn().mockResolvedValue(null) },
    intelSnapshot: { findUnique: jest.fn().mockResolvedValue(null) },
  };

  const pool: any = {
    register: jest.fn(),
    getLive: jest.fn().mockReturnValue(opts.live === undefined ? { marketCapUsd: 0, priceUsd: 0 } : opts.live),
  };

  const realtime: any = { emitGlobal: jest.fn(), emitToUser: jest.fn() };

  const swap = opts.swap ?? jest.fn().mockResolvedValue({ tradeId: 'sell-1', txHash: '0xabc', amountOut: '1000' });
  const exec: any = { swap };

  const service = new ExitEngineService(prisma, pool, realtime, exec);
  return { service, prisma, pool, realtime, swap, updates };
}

const baseTrade = (over: Partial<any> = {}) => ({
  id: 't1',
  userId: 'u1',
  chain: 'SOLANA',
  tokenOut: 'MintAddrXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  amountOut: '1000000',
  priceUsd: 100,          // entry notional USD
  createdAt: new Date(Date.now() - 60_000),
  strategyId: null,       // → default tiers (2x/5x/10x, 50/25/25)
  tiersExecuted: [],
  highestMcapSeen: null,
  realizedProceedsUsd: null,
  sellAttempts: 0,
  sellStuck: false,
  ...over,
});

// Shorthand to invoke the private executeSell.
const sell = (svc: ExitEngineService, trade: any, opts: any) =>
  (svc as any).executeSell(trade, opts);

describe('ExitEngineService.executeSell — reliability', () => {
  afterEach(() => jest.clearAllMocks());

  it('successful partial tier sell marks the tier, accumulates proceeds, does NOT mark exited', async () => {
    const { service, swap, updates } = makeService();
    const trade = baseTrade();

    await sell(service, trade, { reason: 'tier_0', sellFraction: 0.5, mcapRatio: 2, entryUsd: 100, currentPriceUsd: 1 });

    expect(swap).toHaveBeenCalledTimes(1);
    const swapArg = swap.mock.calls[0][0];
    expect(swapArg.tokenIn).toBe(trade.tokenOut);   // selling the held token
    expect(swapArg.tokenOut).toBe(SOL_MINT);        // for SOL
    expect(swapArg.amountIn).toBe('500000');        // 50% of 1,000,000 tokens

    const patch = updates.at(-1);
    expect(patch.tiersExecuted).toEqual([0]);
    expect(patch.realizedProceedsUsd).toBeCloseTo(100); // 100 * 2 * 0.5
    expect(patch.sellAttempts).toBe(0);
    expect(patch.exitAt).toBeUndefined();               // partial — still open
  });

  it('does NOT mark the position sold when the swap fails — increments attempts instead', async () => {
    const swap = jest.fn().mockRejectedValue(new Error('blockhash expired'));
    const { service, realtime, updates } = makeService({ swap });
    const trade = baseTrade();

    await sell(service, trade, { reason: 'tier_0', sellFraction: 0.5, mcapRatio: 2, entryUsd: 100, currentPriceUsd: 1 });

    const patch = updates.at(-1);
    expect(patch.sellAttempts).toBe(1);
    expect(patch.sellStuck).toBe(false);
    expect(patch.lastSellError).toContain('blockhash expired');
    // Crucially: no exit/tier state was written.
    expect(patch.tiersExecuted).toBeUndefined();
    expect(patch.exitAt).toBeUndefined();
    expect(realtime.emitToUser).toHaveBeenCalledWith('u1', 'trade_exit_failed', expect.objectContaining({ attempts: 1, stuck: false }));
  });

  it('treats a missing wallet as a failure (not a phantom exit)', async () => {
    const { service, swap, updates } = makeService({ wallet: null });
    const trade = baseTrade();

    await sell(service, trade, { reason: 'trailing_stop', sellFraction: 1, mcapRatio: 3, entryUsd: 100, currentPriceUsd: 1 });

    expect(swap).not.toHaveBeenCalled();
    const patch = updates.at(-1);
    expect(patch.sellAttempts).toBe(1);
    expect(patch.exitAt).toBeUndefined();
  });

  it('flags the position stuck after MAX_SELL_ATTEMPTS and emits a global alert', async () => {
    const swap = jest.fn().mockRejectedValue(new Error('no route'));
    const { service, realtime, updates } = makeService({ swap });
    // Default MAX_SELL_ATTEMPTS=5; 4 prior failures means this one trips the limit.
    const trade = baseTrade({ sellAttempts: 4 });

    await sell(service, trade, { reason: 'trailing_stop', sellFraction: 1, mcapRatio: 3, entryUsd: 100, currentPriceUsd: 1 });

    const patch = updates.at(-1);
    expect(patch.sellAttempts).toBe(5);
    expect(patch.sellStuck).toBe(true);
    expect(realtime.emitGlobal).toHaveBeenCalledWith('sell_stuck', expect.objectContaining({ tradeId: 't1' }));
  });

  it('escalates slippage with each prior failed attempt', async () => {
    const { service, swap } = makeService();
    const trade = baseTrade({ sellAttempts: 2 });

    await sell(service, trade, { reason: 'tier_0', sellFraction: 0.5, mcapRatio: 2, entryUsd: 100, currentPriceUsd: 1 });

    // base 300 * 2^2 = 1200 bps
    expect(swap.mock.calls[0][0].slippageBps).toBe(1200);
  });

  it('full exit stamps exitAt and realizedPnl = total proceeds across partials minus entry cost', async () => {
    const { service, updates } = makeService();
    // Already banked $100 from an earlier tier; now closing the remainder.
    const trade = baseTrade({ tiersExecuted: [0], realizedProceedsUsd: 100 });

    await sell(service, trade, { reason: 'trailing_stop', sellFraction: 0.5, mcapRatio: 3, entryUsd: 100, currentPriceUsd: 1 });

    const patch = updates.at(-1);
    expect(patch.realizedProceedsUsd).toBeCloseTo(250); // 100 prior + (100*3*0.5)=150
    expect(patch.exitAt).toBeInstanceOf(Date);
    expect(patch.exitReason).toBe('trailing_stop');
    // realizedPnl = total proceeds - entry cost
    expect(patch.realizedPnl).toBeCloseTo(patch.realizedProceedsUsd - 100);
  });
});

describe('ExitEngineService.evaluateTrade — tier firing', () => {
  afterEach(() => jest.clearAllMocks());

  it('fires tier_0 when current mcap reaches the 2x multiple', async () => {
    const { service, swap } = makeService({ live: { marketCapUsd: 200_000, priceUsd: 1 } });
    const trade = baseTrade({ entryMcapUsd: 100_000 });

    await (service as any).evaluateTrade(trade);

    expect(swap).toHaveBeenCalledTimes(1);
    expect(swap.mock.calls[0][0].amountIn).toBe('500000'); // default tier_0 sells 50%
  });

  it('does nothing when there is no live market-cap data yet', async () => {
    const { service, swap } = makeService({ live: null });
    const trade = baseTrade({ entryMcapUsd: 100_000 });

    await (service as any).evaluateTrade(trade);

    expect(swap).not.toHaveBeenCalled();
  });
});

describe('ExitEngineService.evaluateTrade — dynamic exit triggers', () => {
  afterEach(() => jest.clearAllMocks());

  it('dumps the position when liquidity drains from its peak (rug proxy)', async () => {
    const { service, pool, swap } = makeService();
    const trade = baseTrade({ entryMcapUsd: 100_000 });

    // Tick 1 seeds peak liquidity at $100k; not in danger, no tier, no trailing.
    pool.getLive.mockReturnValueOnce({ marketCapUsd: 120_000, priceUsd: 1, liquidityUsd: 100_000, priceChange5m: 0 });
    await (service as any).evaluateTrade(trade);
    expect(swap).not.toHaveBeenCalled();

    // Tick 2: liquidity collapses 70% → liquidity_drain full exit.
    pool.getLive.mockReturnValueOnce({ marketCapUsd: 118_000, priceUsd: 1, liquidityUsd: 30_000, priceChange5m: -5 });
    await (service as any).evaluateTrade(trade);

    expect(swap).toHaveBeenCalledTimes(1);
    expect(swap.mock.calls[0][0].amountIn).toBe('1000000'); // sells the full remaining position
  });

  it('exits on a sharp 5m drop while in profit (momentum reversal)', async () => {
    const { service, pool, swap } = makeService();
    pool.getLive.mockReturnValue({ marketCapUsd: 150_000, priceUsd: 1, liquidityUsd: 100_000, priceChange5m: -30 });
    const trade = baseTrade({ entryMcapUsd: 100_000 }); // 1.5x — in profit, below 2x tier

    await (service as any).evaluateTrade(trade);

    expect(swap).toHaveBeenCalledTimes(1);
  });

  it('fires the trailing stop when price falls below the (volatility-adjusted) band from the peak', async () => {
    const { service, pool, swap } = makeService();
    pool.getLive.mockReturnValue({ marketCapUsd: 150_000, priceUsd: 1, liquidityUsd: 100_000, priceChange5m: 0 });
    // Peak was 300k, now 150k (−50%) — well past the ~30% pre-tier band.
    const trade = baseTrade({ entryMcapUsd: 100_000, highestMcapSeen: 300_000 });

    await (service as any).evaluateTrade(trade);

    expect(swap).toHaveBeenCalledTimes(1);
  });

  it('does not exit a healthy in-profit position holding above its trailing band', async () => {
    const { service, pool, swap } = makeService();
    pool.getLive.mockReturnValue({ marketCapUsd: 150_000, priceUsd: 1, liquidityUsd: 100_000, priceChange5m: 2 });
    const trade = baseTrade({ entryMcapUsd: 100_000, highestMcapSeen: 160_000 }); // only ~6% off peak

    await (service as any).evaluateTrade(trade);

    expect(swap).not.toHaveBeenCalled();
  });
});
