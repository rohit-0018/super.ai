import { TokenResolverService } from './token-resolver.service';
import type { DexSearchPair } from '../token-analysis/providers/dexscreener.provider';

const pair = (p: Partial<DexSearchPair> & { sym: string; addr: string; chainId?: string }): DexSearchPair => ({
  chainId: p.chainId ?? 'solana',
  url: `https://dexscreener.com/${p.chainId ?? 'solana'}/${p.addr}`,
  pairCreatedAt: Date.now() - 48 * 3_600_000,
  baseToken: { address: p.addr, symbol: p.sym, name: p.sym },
  quoteToken: { address: 'SoL', symbol: 'SOL' },
  priceUsd: '0.001',
  liquidity: { usd: 10_000 },
  volume: { h24: 5_000 },
  marketCap: 1_000_000,
  fdv: 1_000_000,
  txns: { h24: { buys: 10, sells: 5 } },
  ...p,
});

function build(opts: { search?: DexSearchPair[]; getToken?: any; cg?: any[] }) {
  const dex = {
    search: jest.fn().mockResolvedValue(opts.search ?? []),
    getToken: jest.fn().mockResolvedValue(opts.getToken ?? null),
  };
  const cg = { searchBySymbol: jest.fn().mockResolvedValue(opts.cg ?? []) };
  const svc = new TokenResolverService(dex as any, cg as any);
  return { svc, dex, cg };
}

describe('TokenResolverService', () => {
  it('classifies unresolvable junk without hitting providers', async () => {
    const { svc, dex } = build({});
    const r = await svc.resolve('hello world!');
    expect(r.kind).toBe('unresolvable');
    expect(dex.search).not.toHaveBeenCalled();
  });

  it('resolves an address to a single candidate, even with no DexScreener data', async () => {
    const { svc } = build({ getToken: null });
    const addr = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
    const r = await svc.resolve(addr);
    expect(r.kind).toBe('address');
    expect(r.candidates).toHaveLength(1);
    expect(r.best?.address).toBe(addr);
    expect(r.best?.matchTier).toBe('address');
  });

  it('collapses a token\'s many pools into one candidate with summed liquidity', async () => {
    const { svc } = build({
      search: [
        pair({ sym: 'BONK', addr: 'BonkMint', liquidity: { usd: 100_000 }, volume: { h24: 20_000 } }),
        pair({ sym: 'BONK', addr: 'BonkMint', liquidity: { usd: 40_000 }, volume: { h24: 5_000 } }),
      ],
    });
    const r = await svc.resolve('$BONK');
    expect(r.kind).toBe('ticker');
    expect(r.candidates).toHaveLength(1);
    expect(r.best?.liquidityUsd).toBe(140_000);
    expect(r.best?.volume24hUsd).toBe(25_000);
    expect(r.best?.matchTier).toBe('exact');
  });

  it('keeps the same symbol on different chains as distinct candidates', async () => {
    const { svc } = build({
      search: [
        pair({ sym: 'BONK', addr: 'BonkSol', chainId: 'solana', liquidity: { usd: 500_000 } }),
        pair({ sym: 'BONK', addr: '0xbonk', chainId: 'base', liquidity: { usd: 9_000 } }),
      ],
    });
    const r = await svc.resolve('$BONK');
    expect(r.candidates).toHaveLength(2);
    expect(r.best?.chain).toBe('SOLANA'); // deeper liquidity ranks first
    expect(r.ambiguous).toBe(true);
  });

  it('drops quote-only matches, dead pools, and unknown chains', async () => {
    const { svc } = build({
      search: [
        // symbol only on the quote side → not a base match
        { ...pair({ sym: 'WIF', addr: 'wifMint' }), baseToken: { address: 'other', symbol: 'OTHER', name: 'Other' } },
        // dead pool
        pair({ sym: 'WIF', addr: 'deadMint', liquidity: { usd: 0 }, volume: { h24: 0 }, txns: { h24: { buys: 0, sells: 0 } } }),
        // unknown chain
        pair({ sym: 'WIF', addr: 'tronMint', chainId: 'tron' }),
        // the real one
        pair({ sym: 'WIF', addr: 'realWif', liquidity: { usd: 250_000 } }),
      ],
    });
    const r = await svc.resolve('WIF');
    expect(r.candidates.map((c) => c.address)).toEqual(['realWif']);
  });

  it('ranks an exact match above a bigger fuzzy match', async () => {
    const { svc } = build({
      search: [
        pair({ sym: 'BONKINU', addr: 'inu', liquidity: { usd: 5_000_000 } }),
        pair({ sym: 'BONK', addr: 'bonk', liquidity: { usd: 50_000 } }),
      ],
    });
    const r = await svc.resolve('$BONK');
    expect(r.best?.symbol).toBe('BONK');
    expect(r.best?.matchTier).toBe('exact');
  });

  it('flags verified when CoinGecko lists the symbol', async () => {
    const { svc } = build({
      search: [pair({ sym: 'BONK', addr: 'bonk' })],
      cg: [{ id: 'bonk', name: 'Bonk', symbol: 'bonk', market_cap_rank: 50 }],
    });
    const r = await svc.resolve('$BONK');
    expect(r.best?.verified).toBe(true);
  });

  it('caches ticker results — one DexScreener call for repeat queries', async () => {
    const { svc, dex } = build({ search: [pair({ sym: 'BONK', addr: 'bonk' })] });
    await svc.resolve('$BONK');
    await svc.resolve('$BONK');
    expect(dex.search).toHaveBeenCalledTimes(1);
  });

  it('returns an empty ticker result (no throw) when DexScreener has nothing', async () => {
    const { svc } = build({ search: [] });
    const r = await svc.resolve('$NOTHING');
    expect(r.kind).toBe('ticker');
    expect(r.candidates).toEqual([]);
    expect(r.best).toBeNull();
    expect(r.confidence).toBe(0);
  });

  describe('resolveForTrade (money-path guard)', () => {
    it('returns the token directly for an address', async () => {
      const { svc } = build({ getToken: { symbol: 'X' } });
      const t = await svc.resolveForTrade('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
      expect(t.matchTier).toBe('address');
    });

    it('auto-picks a dominant top ticker', async () => {
      const { svc } = build({
        search: [
          pair({ sym: 'BONK', addr: 'big', liquidity: { usd: 2_000_000 } }),
          pair({ sym: 'BONK', addr: 'small', chainId: 'base', liquidity: { usd: 6_000 } }),
        ],
      });
      const t = await svc.resolveForTrade('$BONK');
      expect(t.address).toBe('big');
    });

    it('throws 400 when nothing resolves', async () => {
      const { svc } = build({ search: [] });
      await expect(svc.resolveForTrade('$NOPE')).rejects.toMatchObject({ status: 400 });
    });

    it('throws 409 with candidates when two tickers are close', async () => {
      const { svc } = build({
        search: [
          pair({ sym: 'INU', addr: 'a', liquidity: { usd: 110_000 }, volume: { h24: 50_000 } }),
          pair({ sym: 'INU', addr: 'b', liquidity: { usd: 100_000 }, volume: { h24: 48_000 } }),
        ],
      });
      await expect(svc.resolveForTrade('$INU')).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({ reason: 'ambiguous_ticker' }),
      });
    });

    it('throws 409 low_liquidity when the only match is a dust pool', async () => {
      const { svc } = build({ search: [pair({ sym: 'RUG', addr: 'r', liquidity: { usd: 800 }, volume: { h24: 50 } })] });
      await expect(svc.resolveForTrade('$RUG')).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({ reason: 'low_liquidity' }),
      });
    });
  });

  it('honours the chain filter', async () => {
    const { svc } = build({
      search: [
        pair({ sym: 'BONK', addr: 'sol', chainId: 'solana' }),
        pair({ sym: 'BONK', addr: 'evm', chainId: 'base' }),
      ],
    });
    const r = await svc.resolve('$BONK', { chain: 'SOLANA' });
    expect(r.candidates).toHaveLength(1);
    expect(r.best?.chain).toBe('SOLANA');
  });
});
