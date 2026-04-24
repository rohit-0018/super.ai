import { ConvictionEngine } from './conviction.engine';

describe('ConvictionEngine', () => {
  const engine = new ConvictionEngine({} as any);

  it('returns a score in [1,10]', () => {
    const s = engine.score({ securityScore: 80, holderQuality: 70, liquidityScore: 60, sentimentScore: 0.3, momentumScore: 0.5 });
    expect(s).toBeGreaterThanOrEqual(1);
    expect(s).toBeLessThanOrEqual(10);
  });

  it('hard-caps at 1 on HONEYPOT', () => {
    expect(engine.score({ securityScore: 100, riskFlags: ['HONEYPOT'] })).toBe(1);
  });

  it('caps at 4 with non-honeypot risk flags', () => {
    expect(engine.score({ securityScore: 100, holderQuality: 100, liquidityScore: 100, sentimentScore: 1, momentumScore: 1, riskFlags: ['HIDDEN_TAX'] }))
      .toBeLessThanOrEqual(4);
  });
});
