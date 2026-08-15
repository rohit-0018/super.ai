import { EvmBalancesService } from './evm-balances.service';
import { NativePriceService } from './native-price.service';
import { ALL_CHAINS, getChain } from './chain-registry';

/**
 * These tests stub the RPC layer rather than hitting the network, so they stay
 * deterministic. The behaviour under test is the failover and aggregation
 * logic, not ethers itself.
 */
describe('EvmBalancesService', () => {
  const priceStub = (usd: number) =>
    ({ priceFor: jest.fn().mockResolvedValue(usd) } as unknown as NativePriceService);

  /** Replaces the private RPC runner with a scripted implementation. */
  const withStub = (
    svc: EvmBalancesService,
    impl: (chainKey: string) => Promise<unknown>,
  ) => {
    (svc as any).withProvider = (spec: any, fn: any) =>
      impl(spec.key).then((v) => (typeof v === 'function' ? (v as any)(fn) : v));
  };

  it('reports every EVM chain and excludes Solana', async () => {
    const svc = new EvmBalancesService(priceStub(2000));
    withStub(svc, () => Promise.resolve(0n));

    const p = await svc.portfolio('0xabc');
    const evmCount = ALL_CHAINS.filter((c) => c.family === 'EVM').length;

    expect(p.chains).toHaveLength(evmCount);
    expect(p.chains.some((c) => c.chain === 'solana')).toBe(false);
  });

  it('sums USD across chains rather than reporting one chain', async () => {
    const svc = new EvmBalancesService(priceStub(2000));
    // 1 native unit everywhere.
    withStub(svc, () => Promise.resolve(10n ** 18n));

    const p = await svc.portfolio('0xabc');
    const evmCount = ALL_CHAINS.filter((c) => c.family === 'EVM').length;

    // This is the regression that mattered: the old code returned only Ethereum.
    expect(p.totalUsd).toBeCloseTo(2000 * evmCount, 6);
    expect(p.chains.every((c) => c.native === 1)).toBe(true);
  });

  it('uses each chain&apos;s own native symbol, not a hardcoded ETH', async () => {
    const svc = new EvmBalancesService(priceStub(1));
    withStub(svc, () => Promise.resolve(10n ** 18n));

    const p = await svc.portfolio('0xabc');
    const bySymbol = Object.fromEntries(p.chains.map((c) => [c.chain, c.symbol]));

    expect(bySymbol.bsc).toBe('BNB');
    expect(bySymbol.polygon).toBe('POL');
    expect(bySymbol.avalanche).toBe('AVAX');
    expect(bySymbol.base).toBe('ETH');
  });

  it('marks an unreachable chain as errored instead of reporting zero', async () => {
    const svc = new EvmBalancesService(priceStub(2000));
    withStub(svc, (key) =>
      key === 'base'
        ? Promise.reject(new Error('all RPCs failed for base'))
        : Promise.resolve(10n ** 18n),
    );

    const p = await svc.portfolio('0xabc');
    const base = p.chains.find((c) => c.chain === 'base')!;

    // A silent 0 would be indistinguishable from an empty wallet — the whole
    // reason the original single-RPC bug went unnoticed.
    expect(base.error).toBeTruthy();
    expect(base.native).toBe(0);

    // One dead chain must not take down the rest of the portfolio.
    expect(p.chains.filter((c) => !c.error).length).toBeGreaterThan(0);
    expect(p.totalUsd).toBeGreaterThan(0);
  });

  it('scales balances by each chain&apos;s native decimals', async () => {
    const svc = new EvmBalancesService(priceStub(1));
    withStub(svc, () => Promise.resolve(5n * 10n ** 17n)); // 0.5 * 1e18

    const p = await svc.portfolio('0xabc');
    expect(p.chains.every((c) => c.native === 0.5)).toBe(true);
  });

  it('still produces a portfolio when pricing fails entirely', async () => {
    const failing = {
      priceFor: jest.fn().mockRejectedValue(new Error('no price')),
    } as unknown as NativePriceService;
    const svc = new EvmBalancesService(failing);
    withStub(svc, () => Promise.resolve(10n ** 18n));

    const p = await svc.portfolio('0xabc');
    expect(p.totalUsd).toBe(0);
    expect(p.chains.every((c) => c.native === 1)).toBe(true);
  });

  it('exposes an explorer link per chain', async () => {
    const svc = new EvmBalancesService(priceStub(1));
    withStub(svc, () => Promise.resolve(0n));

    const p = await svc.portfolio('0xdeadbeef');
    for (const c of p.chains) {
      expect(c.explorerUrl).toContain('0xdeadbeef');
      expect(c.explorerUrl).toBe(getChain(c.chain).explorerAddressUrl('0xdeadbeef'));
    }
  });
});

describe('RPC failover candidate list', () => {
  it('orders env override ahead of default and fallbacks', () => {
    const base = getChain('base');
    const prev = process.env[base.rpcEnvVar];
    try {
      process.env[base.rpcEnvVar] = 'https://override.example';
      const candidates = [
        ...(process.env[base.rpcEnvVar] ? [process.env[base.rpcEnvVar]!] : []),
        base.defaultRpcUrl,
        ...base.fallbackRpcUrls,
      ];
      expect(candidates[0]).toBe('https://override.example');
      expect(candidates).toContain(base.defaultRpcUrl);
      expect(candidates.length).toBeGreaterThan(2);
    } finally {
      if (prev === undefined) delete process.env[base.rpcEnvVar];
      else process.env[base.rpcEnvVar] = prev;
    }
  });

  it('gives every chain at least one fallback so a single outage is survivable', () => {
    for (const c of ALL_CHAINS) {
      expect(c.fallbackRpcUrls.length).toBeGreaterThan(0);
      expect(c.fallbackRpcUrls).not.toContain(c.defaultRpcUrl);
    }
  });
});
