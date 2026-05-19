import { ExecutionService } from './execution.service';

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
  const liveGuard: any = {
    checkLiveSwap: jest.fn().mockResolvedValue(undefined),
    checkLiveWithdraw: jest.fn().mockResolvedValue(undefined),
    invalidate: jest.fn(),
  };
  const jito: any = {
    tipLamports: jest.fn().mockReturnValue(100_000),
    submitBundle: jest.fn().mockResolvedValue({ bundleId: '', accepted: false }),
    waitForBundle: jest.fn().mockResolvedValue(false),
  };
  const raydium: any = {
    quote: jest.fn().mockResolvedValue({ inputMint: 'i', outputMint: 'o', inAmount: '100', outAmount: '95', priceImpactPct: '0.1' }),
    swapTx: jest.fn().mockResolvedValue('base64=='),
  };
  const paraswap: any = {
    quote: jest.fn().mockResolvedValue({ srcToken: 'i', destToken: 'o', srcAmount: '100', destAmount: '95', priceRoute: {} }),
    buildTx: jest.fn().mockResolvedValue({ to: '0x', data: '0x', value: '0', gas: '0', gasPrice: '0' }),
  };
  const approvals: any = {
    requestAndWait: jest.fn().mockResolvedValue(true),
  };
  const svc = new ExecutionService(prisma, guardrails, jup, jito, oneinch, raydium, paraswap, wallets, dna, emotional, securityCompliance, riskEngine, securityAudit, liveGuard, approvals);
  return { svc, prisma, guardrails, jup, oneinch, wallets, dna, trades, audits, paperBalances };
}

const baseInput = {
  userId: 'u',
  walletId: 'w',
  chain: 'SOLANA' as const,
  tokenIn: 'USDC',
  tokenOut: 'SOL',
  amountIn: '100',
  notionalUsd: 100,
  slippageBps: 100,
};

describe('ExecutionService.swap', () => {
  it('blocks when guardrail fails', async () => {
    const { svc } = makeService({ guardrail: { ok: false, reason: 'KILL_SWITCH_ON' } });
    await expect(svc.swap(baseInput)).rejects.toMatchObject({ response: { guardrail: 'KILL_SWITCH_ON' } });
  });

  it('records paper trade without signing', async () => {
    const { svc, wallets, trades, paperBalances } = makeService({ paperMode: true });
    const r = await svc.swap(baseInput);
    expect(r.mode).toBe('PAPER');
    expect(r.txHash).toBeNull();
    expect(wallets.withSigningKey).not.toHaveBeenCalled();
    expect(trades.length).toBe(1);
    expect(paperBalances.get('SOL')).toBe('95');
  });

  it('throws when Jupiter returns no swapTransaction (live)', async () => {
    const { svc } = makeService({ paperMode: false, swapTx: {} });
    await expect(svc.swap(baseInput)).rejects.toThrow(/no swapTransaction/);
  });
});
