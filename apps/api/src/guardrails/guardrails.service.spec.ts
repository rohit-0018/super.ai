import { GuardrailsService } from './guardrails.service';

const fakeCfg = (over: any = {}) => ({
  perTradeUsd: 500, dailyUsd: 2000, maxSlippageBps: 150,
  whitelist: [], blacklist: [], killSwitch: false, ...over,
});

function makeSvc(cfg: any, dayUsed = 0) {
  const prisma: any = {
    guardrailConfig: { upsert: jest.fn().mockResolvedValue(cfg), update: jest.fn().mockResolvedValue(cfg) },
    trade: { aggregate: jest.fn().mockResolvedValue({ _sum: { priceUsd: dayUsed } }) },
  };
  return new GuardrailsService(prisma);
}

describe('GuardrailsService.check', () => {
  const intent = { userId: 'u', tokenAddress: 'tok', chain: 'EVM' as const, notionalUsd: 100, slippageBps: 100 };

  it('passes a normal trade', async () => {
    const r = await makeSvc(fakeCfg()).check(intent);
    expect(r.ok).toBe(true);
  });

  it('blocks when kill switch on', async () => {
    const r = await makeSvc(fakeCfg({ killSwitch: true })).check(intent);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('KILL_SWITCH_ON');
  });

  it('blocks blacklisted token', async () => {
    const r = await makeSvc(fakeCfg({ blacklist: ['tok'] })).check(intent);
    expect(r.reason).toBe('TOKEN_BLACKLISTED');
  });

  it('blocks above per-trade cap', async () => {
    const r = await makeSvc(fakeCfg()).check({ ...intent, notionalUsd: 9999 });
    expect(r.reason).toContain('PER_TRADE_LIMIT');
  });

  it('blocks above slippage cap', async () => {
    const r = await makeSvc(fakeCfg()).check({ ...intent, slippageBps: 9999 });
    expect(r.reason).toContain('SLIPPAGE_CAP');
  });

  it('blocks honeypot', async () => {
    const r = await makeSvc(fakeCfg()).check({ ...intent, riskFlags: ['HONEYPOT'] });
    expect(r.reason).toBe('HONEYPOT_FLAG');
  });

  it('blocks above daily cap', async () => {
    const r = await makeSvc(fakeCfg(), 1950).check(intent);
    expect(r.reason).toContain('DAILY_CAP');
  });
});
