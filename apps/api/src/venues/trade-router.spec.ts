import { toBaseUnits } from './trade-router.service';

/**
 * Order sizing is the highest-consequence pure function in the venue layer:
 * an off-by-a-decimal here submits a trade 10x the intended size, and the
 * naive `Math.floor(amount * 10 ** decimals)` approach genuinely breaks at
 * 18 decimals because the intermediate float is not an integer.
 */
describe('toBaseUnits', () => {
  it('converts whole and fractional amounts at 9 decimals (SOL)', () => {
    expect(toBaseUnits(1, 9)).toBe('1000000000');
    expect(toBaseUnits(0.5, 9)).toBe('500000000');
    expect(toBaseUnits(1.5, 9)).toBe('1500000000');
  });

  it('is exact at 18 decimals where float math loses precision', () => {
    expect(toBaseUnits(1, 18)).toBe('1000000000000000000');
    expect(toBaseUnits(0.1, 18)).toBe('100000000000000000');
    expect(toBaseUnits(1.1, 18)).toBe('1100000000000000000');
  });

  it('avoids the naive-multiply error that silently corrupts wei amounts', () => {
    // The bug this function exists to prevent: `1.1 * 10 ** 18` evaluates to
    // 1100000000000000128 — 128 wei more than the user asked to spend. The
    // value is still an integer, so a Number.isInteger guard would not catch it.
    expect(1.1 * 10 ** 18).toBe(1_100_000_000_000_000_128);
    expect(toBaseUnits(1.1, 18)).toBe('1100000000000000000');

    expect(toBaseUnits(1.1, 18)).not.toContain('.');
    expect(toBaseUnits(1.1, 18)).not.toMatch(/e/i);
  });

  it('never emits exponential notation for small amounts', () => {
    const out = toBaseUnits(0.000001, 18);
    expect(out).not.toMatch(/e/i);
    expect(out).toBe('1000000000000');
  });

  it('truncates below the smallest representable unit instead of rounding up', () => {
    // 6-decimal token: anything under 1e-6 is not representable.
    expect(toBaseUnits(0.0000001, 6)).toBe('0');
    expect(toBaseUnits(0.000001, 6)).toBe('1');
  });

  it('rejects non-positive and non-finite input', () => {
    expect(toBaseUnits(0, 18)).toBe('0');
    expect(toBaseUnits(-1, 18)).toBe('0');
    expect(toBaseUnits(NaN, 18)).toBe('0');
    expect(toBaseUnits(Infinity, 18)).toBe('0');
  });

  it('strips leading zeros so the result is a canonical integer string', () => {
    const out = toBaseUnits(0.25, 8);
    expect(out).toBe('25000000');
    expect(out.startsWith('0')).toBe(false);
  });

  it('produces values that survive a BigInt round-trip', () => {
    for (const [amt, dec] of [[1, 18], [0.1, 18], [12.345, 9], [0.5, 6]] as const) {
      expect(() => BigInt(toBaseUnits(amt, dec))).not.toThrow();
    }
  });

  it('scales linearly — 2x the input is 2x the base units', () => {
    const one = BigInt(toBaseUnits(1, 18));
    const two = BigInt(toBaseUnits(2, 18));
    expect(two).toBe(one * 2n);
  });
});

/**
 * The percentage-of-position maths used by sell(). Applied in integer space
 * for the same reason: a 100% sell that rounds down leaves dust behind, and
 * dust can block a position from ever closing cleanly.
 */
describe('sell percentage arithmetic', () => {
  const applyPercent = (raw: string, pct: number) =>
    ((BigInt(raw) * BigInt(Math.round(pct * 100))) / 10_000n).toString();

  it('sells the exact full balance at 100%', () => {
    const bal = '123456789012345678';
    expect(applyPercent(bal, 100)).toBe(bal);
  });

  it('halves cleanly at 50%', () => {
    expect(applyPercent('1000000000000000000', 50)).toBe('500000000000000000');
  });

  it('supports fractional percentages', () => {
    expect(applyPercent('1000000', 12.5)).toBe('125000');
  });

  it('never exceeds the balance', () => {
    const bal = '999999999999999999';
    for (const pct of [1, 25, 33.3, 50, 99, 100]) {
      expect(BigInt(applyPercent(bal, pct))).toBeLessThanOrEqual(BigInt(bal));
    }
  });
});
