import {
  ALL_CHAINS,
  CHAIN_KEYS,
  chainsForAddress,
  fromCoinGecko,
  fromDexScreener,
  fromEvmChainId,
  fromGeckoTerminal,
  getChain,
  resolveChain,
  rpcUrlFor,
} from './chain-registry';

describe('chain-registry', () => {
  it('registers every key exactly once with a self-consistent key field', () => {
    expect(CHAIN_KEYS.length).toBe(ALL_CHAINS.length);
    for (const c of ALL_CHAINS) expect(getChain(c.key)).toBe(c);
  });

  it('has unique provider ids so reverse lookups are unambiguous', () => {
    const dex = ALL_CHAINS.map((c) => c.ids.dexscreener);
    const gecko = ALL_CHAINS.map((c) => c.ids.geckoterminal);
    const cg = ALL_CHAINS.map((c) => c.ids.coingecko);
    expect(new Set(dex).size).toBe(dex.length);
    expect(new Set(gecko).size).toBe(gecko.length);
    expect(new Set(cg).size).toBe(cg.length);
  });

  it('has unique EVM chain ids', () => {
    const ids = ALL_CHAINS.filter((c) => c.evmChainId).map((c) => c.evmChainId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // The whole point of the registry: providers disagree about chain names.
  it('maps the provider slugs that actually differ', () => {
    expect(fromGeckoTerminal('eth')?.key).toBe('ethereum');
    expect(fromDexScreener('ethereum')?.key).toBe('ethereum');
    expect(fromGeckoTerminal('polygon_pos')?.key).toBe('polygon');
    expect(fromDexScreener('polygon')?.key).toBe('polygon');
    expect(fromGeckoTerminal('avax')?.key).toBe('avalanche');
    expect(fromDexScreener('avalanche')?.key).toBe('avalanche');
    expect(fromCoinGecko('optimistic-ethereum')?.key).toBe('optimism');
    expect(fromCoinGecko('binance-smart-chain')?.key).toBe('bsc');
    expect(fromCoinGecko('arbitrum-one')?.key).toBe('arbitrum');
  });

  it('resolves EVM chain ids both as number and numeric string', () => {
    expect(fromEvmChainId(8453)?.key).toBe('base');
    expect(resolveChain(42161)?.key).toBe('arbitrum');
    expect(resolveChain('56')?.key).toBe('bsc');
  });

  it('resolves the legacy Prisma enum without losing meaning', () => {
    expect(resolveChain('SOLANA')?.key).toBe('solana');
    // Legacy EVM rows defaulted to Ethereum in the old resolveEvmChainId.
    expect(resolveChain('EVM')?.key).toBe('ethereum');
  });

  it('is case-insensitive and whitespace tolerant', () => {
    expect(resolveChain('  Base ')?.key).toBe('base');
    expect(resolveChain('BSC')?.key).toBe('bsc');
  });

  it('returns null for unknown or empty input rather than guessing', () => {
    expect(resolveChain('dogechain')).toBeNull();
    expect(resolveChain('')).toBeNull();
    expect(resolveChain(null)).toBeNull();
    expect(resolveChain(undefined)).toBeNull();
    expect(fromEvmChainId(999_999)).toBeNull();
  });

  it('narrows candidate chains from address shape', () => {
    const evm = chainsForAddress('0x4200000000000000000000000000000000000006');
    expect(evm.length).toBeGreaterThan(1);
    expect(evm.every((c) => c.family === 'EVM')).toBe(true);

    const sol = chainsForAddress('So11111111111111111111111111111111111111112');
    expect(sol.map((c) => c.key)).toEqual(['solana']);

    expect(chainsForAddress('not-an-address')).toEqual([]);
    // Too short to be a valid base58 mint.
    expect(chainsForAddress('abc')).toEqual([]);
  });

  it('every chain carries the fields the router depends on', () => {
    for (const c of ALL_CHAINS) {
      expect(c.wrappedNative).toBeTruthy();
      expect(c.usdc).toBeTruthy();
      expect(c.nativeDecimals).toBeGreaterThan(0);
      expect(c.explorerTxUrl('0xabc')).toContain('0xabc');
      expect(c.explorerAddressUrl('0xdef')).toContain('0xdef');
      // EVM chains must have a numeric id; Solana must not.
      if (c.family === 'EVM') expect(c.evmChainId).toBeGreaterThan(0);
      else expect(c.evmChainId).toBeUndefined();
    }
  });

  it('honours the per-chain RPC env override', () => {
    const base = getChain('base');
    const prev = process.env[base.rpcEnvVar];
    try {
      delete process.env[base.rpcEnvVar];
      expect(rpcUrlFor(base)).toBe(base.defaultRpcUrl);

      process.env[base.rpcEnvVar] = 'https://my-private-base-rpc.example';
      expect(rpcUrlFor(base)).toBe('https://my-private-base-rpc.example');
    } finally {
      if (prev === undefined) delete process.env[base.rpcEnvVar];
      else process.env[base.rpcEnvVar] = prev;
    }
  });
});
