import { scoreToken, sortCandidates, computeConfidence } from './ranking';
import type { ResolvedToken } from './token-resolver.types';

const base: ScoreArgs = {
  liquidityUsd: 0, volume24hUsd: 0, marketCapUsd: 0,
  txns24h: 0, pairAgeHours: 0, verified: false,
};
type ScoreArgs = Parameters<typeof scoreToken>[0];

describe('scoreToken', () => {
  it('is monotonic in liquidity', () => {
    const lo = scoreToken({ ...base, liquidityUsd: 1_000 });
    const hi = scoreToken({ ...base, liquidityUsd: 1_000_000 });
    expect(hi).toBeGreaterThan(lo);
  });

  it('treats null metrics as zero (no NaN)', () => {
    const s = scoreToken({
      liquidityUsd: null, volume24hUsd: null, marketCapUsd: null,
      txns24h: null, pairAgeHours: null, verified: false,
    });
    expect(Number.isFinite(s)).toBe(true);
    expect(s).toBe(0);
  });

  it('gives a verified token a nudge', () => {
    expect(scoreToken({ ...base, liquidityUsd: 50_000, verified: true }))
      .toBeGreaterThan(scoreToken({ ...base, liquidityUsd: 50_000, verified: false }));
  });

  it('caps the age boost at ~30 days', () => {
    const at30d = scoreToken({ ...base, pairAgeHours: 720 });
    const at90d = scoreToken({ ...base, pairAgeHours: 720 * 3 });
    expect(at90d).toBeCloseTo(at30d);
  });
});

const mk = (p: Partial<ResolvedToken>): ResolvedToken => ({
  chain: 'SOLANA', chainId: 'solana', address: 'x', symbol: 'X', name: 'X',
  priceUsd: null, liquidityUsd: null, volume24hUsd: null, marketCapUsd: null,
  fdvUsd: null, pairAgeHours: null, txns24h: null, logoURI: null, url: null,
  verified: false, score: 0, matchTier: 'fuzzy', ...p,
});

describe('sortCandidates', () => {
  it('puts an exact match above a much bigger fuzzy match', () => {
    const fuzzyWhale = mk({ symbol: 'BONKINU', matchTier: 'fuzzy', score: 99 });
    const exactSmall = mk({ symbol: 'BONK', matchTier: 'exact', score: 3 });
    const [first] = sortCandidates([fuzzyWhale, exactSmall]);
    expect(first.symbol).toBe('BONK');
  });

  it('orders by score within the same match tier', () => {
    const a = mk({ address: 'a', matchTier: 'exact', score: 5 });
    const b = mk({ address: 'b', matchTier: 'exact', score: 9 });
    expect(sortCandidates([a, b]).map((t) => t.address)).toEqual(['b', 'a']);
  });

  it('does not mutate the input array', () => {
    const arr = [mk({ score: 1 }), mk({ score: 2 })];
    const copy = [...arr];
    sortCandidates(arr);
    expect(arr).toEqual(copy);
  });
});

describe('computeConfidence', () => {
  it('is 1 for a single candidate', () => {
    expect(computeConfidence([mk({ score: 4 })])).toBe(1);
  });

  it('is high when #1 is a better tier than #2', () => {
    const sorted = [mk({ matchTier: 'exact', score: 2 }), mk({ matchTier: 'fuzzy', score: 2 })];
    expect(computeConfidence(sorted)).toBeGreaterThanOrEqual(0.85);
  });

  it('reflects the score gap within the same tier', () => {
    const dominant = [mk({ matchTier: 'exact', score: 10 }), mk({ matchTier: 'exact', score: 1 })];
    const close = [mk({ matchTier: 'exact', score: 10 }), mk({ matchTier: 'exact', score: 9 })];
    expect(computeConfidence(dominant)).toBeGreaterThan(computeConfidence(close));
  });
});
