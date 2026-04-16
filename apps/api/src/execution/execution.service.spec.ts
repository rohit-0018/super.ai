import { ExecutionService, SwapExecutionError } from './execution.service';

const ok = async () => ({ ok: true });

function makeService(overrides: {
  paperMode?: boolean;
  guardrail?: { ok: boolean; reason?: string };
  quote?: any;
  swapTx?: any;
  oneinchSwap?: any;
} = {}) {
  const trades: any[] = [];
  const audits: any[] = [];
  const paperBalances = new Map<string, string>();

  const prisma: any = {
    user: { findUnique: jest.fn().mockResolvedValue({ paperMode: overrides.paperMode ?? false }) },
    wallet: { findFirst: jest.fn().mockResolvedValue({ id: 'w', userId: 'u', address: 'addr', chain: 'SOLANA' }) },
    trade: {
      create: jest.fn((args) => {
        const t = { id: `t${trades.length}`, ...args.data };
        trades.push(t);
        return Promise.resolve(t);
      }),
    },
    order: { update: jest.fn().mockResolvedValue({}) },
    auditLog: { create: jest.fn((a) => { audits.push(a.data); return Promise.resolve({}); }) },
    paperBalance: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn(({ create }) => { paperBalances.set(create.token, create.amount); return Promise.resolve(create); }),
    },
  };
  const guardrails: any = {
    check: jest.fn().mockResolvedValue(overrides.guardrail ?? { ok: true }),
    config: jest.fn().mockResolvedValue({ killSwitch: (overrides as any).killSwitch ?? false }),
  };
  const jup: any = {
    quote: jest.fn().mockResolvedValue(overrides.quote ?? { inputMint: 'i', outputMint: 'o', inAmount: '100', outAmount: '95', priceImpactPct: '0.1', routePlan: [] }),
    swapTx: jest.fn().mockResolvedValue(overrides.swapTx ?? { swapTransaction: 'base64==' }),
  };
  const oneinch: any = {
    quote: jest.fn().mockResolvedValue({ dstAmount: '95' }),
    swap: jest.fn().mockResolvedValue(overrides.oneinchSwap ?? { dstAmount: '95', tx: { to: '0x', data: '0x', value: '0', gas: '0', gasPrice: '0' } }),
  };
  const wallets: any = {
    withSigningKey: jest.fn().mockResolvedValue('mock-tx-hash'),
  };
  const dna: any = { recordTrade: jest.fn().mockResolvedValue(undefined) };
  const emotional: any = { evaluate: jest.fn().mockResolvedValue(undefined) };

  const securityCompliance: any = {
    checkWashTrade: jest.fn().mockResolvedValue({ detected: false }),
    recordOrder: jest.fn().mockResolvedValue(undefined),
  };
  const riskEngine: any = {
    evaluate: jest.fn().mockResolvedValue({ approved: true, riskLevel: 'LOW', blockReasons: [] }),
  };
  const securityAudit: any = {
    log: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new ExecutionService(prisma, guardrails, jup, oneinch, wallets, dna, emotional, securityCompliance, riskEngine, securityAudit);
  return { svc, prisma, guardrails, jup, oneinch, wallets, dna, trades, audits, paperBalances, securityCompliance, riskEngine, securityAudit };
}

const baseInput = {
  userId: 'u',
  walletId: 'w',
  chain: 'SOLANA' as const,
  // USDC mainnet mint — counts as a quote asset so tokenIn=USDC → side=buy
  tokenIn: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  tokenOut: 'MEMEtokenMintAddressXXXXXXXXXXXXXXXXXXXXXXX',
  amountIn: '100',
  notionalUsd: 100,
  slippageBps: 100,
};

describe('ExecutionService.swap', () => {
  it('blocks when guardrail fails', async () => {
    const { svc } = makeService({ guardrail: { ok: false, reason: 'KILL_SWITCH_ON' } });
    await expect(svc.swap(baseInput)).rejects.toMatchObject({ response: { guardrail: 'KILL_SWITCH_ON' } });
  });

  it('paper mode: pure simulation, status=SIMULATED_PAPER, never signs, formatted message', async () => {
    const { svc, wallets, trades, paperBalances } = makeService({ paperMode: true });
    const r = await svc.swap(baseInput);
    expect(r.mode).toBe('PAPER');
    expect(r.status).toBe('SIMULATED_PAPER');
    expect(r.simulated).toBe(true);
    expect(r.txHash).toMatch(/^paper-/);
    expect(r.explorerUrl).toBeNull();
    expect(r.message).toContain('📝');
    expect(r.message).toContain('Paper trade');
    expect(r.message).toContain('virtual portfolio');
    expect(wallets.withSigningKey).not.toHaveBeenCalled();
    expect(trades.length).toBe(1);
    expect(paperBalances.get(baseInput.tokenOut)).toBe('95');
  });

  it('source tagging: trades carry the source you passed in', async () => {
    const { svc, trades } = makeService({ paperMode: true });
    await svc.swap({ ...baseInput, source: 'TELEGRAM' });
    expect(trades[0].source).toBe('TELEGRAM');
  });

  it('source tagging: defaults to FAST_LANE when fastLane:true', async () => {
    const { svc, trades } = makeService({ paperMode: true });
    await svc.swap({ ...baseInput, fastLane: true });
    expect(trades[0].source).toBe('FAST_LANE');
  });

  it('source tagging: defaults to API when neither source nor fastLane provided', async () => {
    const { svc, trades } = makeService({ paperMode: true });
    await svc.swap(baseInput);
    expect(trades[0].source).toBe('API');
  });

  it('REGRESSION: refuses to self-transfer on mainnet when Jupiter returns no swapTransaction', async () => {
    // The $200 SOL "buy" that became a self-send was caused by the old
    // `|| !swap?.swapTransaction` fallthrough. On mainnet the code now MUST
    // throw a structured SWAP_FAILED response instead of calling withSigningKey.
    const prevMode = process.env.NETWORK_MODE;
    process.env.NETWORK_MODE = 'mainnet';
    try {
      const { svc, wallets } = makeService({ paperMode: false, swapTx: {} });
      await expect(svc.swap(baseInput)).rejects.toMatchObject({
        response: {
          error: 'SWAP_FAILED',
          reason: 'JUPITER_NO_SWAP_TX',
        },
      });
      expect(wallets.withSigningKey).not.toHaveBeenCalled();
    } finally {
      process.env.NETWORK_MODE = prevMode;
    }
  });

  it('failure response includes a pre-formatted chatMessage with reason hint', async () => {
    const prevMode = process.env.NETWORK_MODE;
    process.env.NETWORK_MODE = 'mainnet';
    try {
      const { svc } = makeService({ paperMode: false, swapTx: {} });
      const err = await svc.swap(baseInput).catch((e) => e);
      expect(err.response.chatMessage).toContain('❌');
      expect(err.response.chatMessage).toContain('Swap failed');
      expect(err.response.chatMessage).toContain('JUPITER_NO_SWAP_TX');
      expect(err.response.chatMessage).toContain('No funds moved');
    } finally {
      process.env.NETWORK_MODE = prevMode;
    }
  });

  it('testnet: PURE simulation — synthetic hash, never calls withSigningKey, never touches chain', async () => {
    const prevMode = process.env.NETWORK_MODE;
    process.env.NETWORK_MODE = 'testnet';
    try {
      const { svc, wallets } = makeService({
        paperMode: false,
        swapTx: { swapTransaction: null, testnetMock: true },
      });
      const r = await svc.swap(baseInput);
      expect(r.mode).toBe('LIVE');
      expect(r.status).toBe('SIMULATED_TESTNET');
      expect(r.simulated).toBe(true);
      expect(r.network).toBe('testnet');
      expect(r.txHash).toMatch(/^testnet-sim-/);
      expect(r.explorerUrl).toBeNull();
      expect(r.message).toContain('🧪');
      expect(r.message).toContain('Testnet simulation');
      expect(r.message).toContain('No funds moved');
      // CRITICAL: signing key must never be touched on testnet sim
      expect(wallets.withSigningKey).not.toHaveBeenCalled();
    } finally {
      process.env.NETWORK_MODE = prevMode;
    }
  });

  it('records side=buy when tokenIn is a quote asset (USDC → MEME)', async () => {
    const { svc, trades } = makeService({ paperMode: true });
    const r = await svc.swap(baseInput);
    expect(r.side).toBe('buy');
    expect(trades[0].side).toBe('buy');
  });

  it('records side=sell when tokenIn is a non-quote asset (MEME → USDC)', async () => {
    const { svc, trades } = makeService({ paperMode: true });
    const r = await svc.swap({
      ...baseInput,
      tokenIn: baseInput.tokenOut,
      tokenOut: baseInput.tokenIn,
    });
    expect(r.side).toBe('sell');
    expect(trades[0].side).toBe('sell');
  });

  it('live Solana swap on mainnet: status=CONFIRMED, real Solscan link, ✅ message', async () => {
    const prevMode = process.env.NETWORK_MODE;
    process.env.NETWORK_MODE = 'mainnet';
    try {
      const { svc } = makeService({
        paperMode: false,
        swapTx: { swapTransaction: 'base64==' },
      });
      const spy = jest
        .spyOn(svc as any, 'executeSolana')
        .mockResolvedValue({ txHash: '5xFakeSignature', outAmount: '42' });
      const r = await svc.swap(baseInput);
      expect(r.txHash).toBe('5xFakeSignature');
      expect(r.status).toBe('CONFIRMED');
      expect(r.simulated).toBe(false);
      expect(r.network).toBe('mainnet');
      expect(r.explorerUrl).toBe('https://solscan.io/tx/5xFakeSignature');
      expect(r.explorerLabel).toBe('Solscan');
      expect(r.message).toContain('✅');
      expect(r.message).toContain('On-chain and confirmed');
      expect(r.message).toContain('[View on Solscan →](https://solscan.io/tx/5xFakeSignature)');
      spy.mockRestore();
    } finally {
      process.env.NETWORK_MODE = prevMode;
    }
  });

  it('paper mode returns null explorerUrl (no on-chain tx to link)', async () => {
    const { svc } = makeService({ paperMode: true });
    const r = await svc.swap(baseInput);
    expect(r.explorerUrl).toBeNull();
  });

  it('SwapExecutionError is importable and carries structured context', () => {
    const err = new SwapExecutionError('x', 'JUPITER_NO_SWAP_TX', { foo: 1 });
    expect(err.reason).toBe('JUPITER_NO_SWAP_TX');
    expect(err.context).toEqual({ foo: 1 });
    expect(err).toBeInstanceOf(Error);
  });

  it('fast lane skips security checks but still executes trade', async () => {
    const { svc, securityCompliance, riskEngine, guardrails, trades } = makeService({ paperMode: true });
    const r = await svc.swap({ ...baseInput, fastLane: true });
    expect(r.mode).toBe('PAPER');
    expect(trades.length).toBe(1);
    // Security compliance and risk engine should NOT have been called
    expect(securityCompliance.checkWashTrade).not.toHaveBeenCalled();
    expect(riskEngine.evaluate).not.toHaveBeenCalled();
    expect(guardrails.check).not.toHaveBeenCalled();
    // But guardrails.config was called (kill switch check)
    expect(guardrails.config).toHaveBeenCalledWith('u');
  });

  it('fast lane still blocks when kill switch is active', async () => {
    const { svc } = makeService({ killSwitch: true } as any);
    await expect(svc.swap({ ...baseInput, fastLane: true })).rejects.toThrow(
      /Kill switch active/,
    );
  });
});
