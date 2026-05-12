import { computeHotTokenScore, type ScoringInput } from './scoring';

// Baseline neutral input — no price action, no tape data, no pump.fun fields.
// Score reduces to BASE(35) + age signal only. We use this as a fixture and
// override fields per test so each case stays minimal.
const baseline = (overrides: Partial<ScoringInput> = {}): ScoringInput => ({
  priceChange1h: 0,
  priceChange5m: 0,
  priceChange24h: 0,
  volume24hUsd: 0,
  liquidityUsd: 0,
  marketCapUsd: 0,
  pairAgeHours: 2,
  source: 'dexscreener_boost',
  ...overrides,
});

describe('computeHotTokenScore', () => {
  // ── Backwards-compat: legacy callers (no tape, no pump fields) ──────────
  it('produces a deterministic baseline with zero signals', () => {
    // swing_trader at 24h: profile-age branch matches (>=6 && <=168) but
    // doesn't push a summary tag — handy for testing the "no tags" path.
    const r = computeHotTokenScore(baseline({ pairAgeHours: 24 }), 'swing_trader');
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.summary).toBe('on watch');
  });

  it('returns identical score whether pump fields are undefined or absent', () => {
    const a = computeHotTokenScore(baseline({ priceChange1h: 60 }), 'meme_hunter');
    const b = computeHotTokenScore(
      baseline({ priceChange1h: 60, bondingCurvePct: undefined, replyCount: undefined }),
      'meme_hunter',
    );
    expect(a.score).toBe(b.score);
  });

  // ── Phase 1: tape quality ───────────────────────────────────────────────
  it('rewards strong buy-ratio + active tape', () => {
    const r = computeHotTokenScore(
      baseline({
        priceChange1h: 30,
        marketCapUsd: 300_000, liquidityUsd: 60_000,
        volume24hUsd: 200_000, // realistic 24h volume so volLiq doesn't penalize
        buys1h: 250, sells1h: 100, volume1hUsd: 80_000,
      }),
      'meme_hunter',
    );
    expect(r.verdict === 'STRONG_BUY' || r.verdict === 'BUY').toBe(true);
    // Score reflects the +7 buy-ratio + tape activity stack
    expect(r.score).toBeGreaterThan(75);
  });

  it('crushes high-MC tokens with dust trades (thin-tape dampener)', () => {
    const r = computeHotTokenScore(
      baseline({
        priceChange1h: 200, priceChange5m: 25, // would normally score huge
        marketCapUsd: 2_000_000, liquidityUsd: 100_000, volume24hUsd: 5_000,
        buys1h: 8, sells1h: 12, volume1hUsd: 200, // $10 avg, 20 tx
      }),
      'meme_hunter',
    );
    expect(r.verdict).toBe('HIGH_RISK');
    expect(r.summary).toMatch(/paper tape|thin tape|dust/i);
  });

  it('does NOT trigger thin-tape on small-MC tokens (expected behavior)', () => {
    // A $50k MC token with low-dollar trades is normal, not a fake pump.
    const r = computeHotTokenScore(
      baseline({
        priceChange1h: 50,
        marketCapUsd: 50_000, liquidityUsd: 15_000,
        buys1h: 30, sells1h: 25, volume1hUsd: 1_500, // $27 avg, fine for small MC
      }),
      'meme_hunter',
    );
    expect(r.summary).not.toMatch(/thin tape|paper tape/);
  });

  it('flags wash-trade signature (huge 24h vol vs MC, almost no live tx)', () => {
    const r = computeHotTokenScore(
      baseline({
        priceChange1h: 80,
        marketCapUsd: 500_000, volume24hUsd: 800_000, // 1.6x MC turnover
        liquidityUsd: 40_000,
        buys1h: 5, sells1h: 5, volume1hUsd: 2_000, // only 10 live tx → wash
      }),
      'meme_hunter',
    );
    expect(r.summary).toMatch(/wash/);
  });

  // ── Phase 2: pump.fun bonding curve ─────────────────────────────────────
  it('penalizes pre-graduation tokens stuck below 30% bonding curve', () => {
    const stuck = computeHotTokenScore(
      baseline({ priceChange1h: 30, bondingCurvePct: 15, graduated: false }),
      'meme_hunter',
    );
    const active = computeHotTokenScore(
      baseline({ priceChange1h: 30, bondingCurvePct: 50, graduated: false }),
      'meme_hunter',
    );
    expect(stuck.score).toBeLessThan(active.score);
    expect(stuck.summary).toMatch(/dead curve/);
  });

  it('rewards tokens near graduation (70–95% bonding)', () => {
    const near = computeHotTokenScore(
      baseline({ priceChange1h: 20, bondingCurvePct: 85, graduated: false }),
      'meme_hunter',
    );
    const mid = computeHotTokenScore(
      baseline({ priceChange1h: 20, bondingCurvePct: 50, graduated: false }),
      'meme_hunter',
    );
    expect(near.score).toBeGreaterThan(mid.score);
  });

  // ── Phase 2: community signals ──────────────────────────────────────────
  it('boosts tokens with high reply count + active livestream', () => {
    const cold = computeHotTokenScore(
      baseline({ priceChange1h: 15, replyCount: 0, isLive: false }),
      'meme_hunter',
    );
    const hot = computeHotTokenScore(
      baseline({ priceChange1h: 15, replyCount: 600, isLive: true }),
      'meme_hunter',
    );
    // 8 (replyCount>500) + 5 (isLive) = +13 bullish delta
    expect(hot.score - cold.score).toBeGreaterThanOrEqual(13);
  });

  // ── Phase 2: dead-bag dampener ──────────────────────────────────────────
  it('damps tokens trading <30% of ATH after they age out', () => {
    const deadBag = computeHotTokenScore(
      baseline({
        priceChange1h: 40, priceChange5m: 8, // bullish on the face of it
        marketCapUsd: 150_000, athMarketCapUsd: 2_000_000, // 7.5% of ATH
        pairAgeHours: 12,
      }),
      'meme_hunter',
    );
    const stillRunning = computeHotTokenScore(
      baseline({
        priceChange1h: 40, priceChange5m: 8,
        marketCapUsd: 1_500_000, athMarketCapUsd: 2_000_000, // 75% of ATH
        pairAgeHours: 12,
      }),
      'meme_hunter',
    );
    expect(deadBag.score).toBeLessThan(stillRunning.score);
    expect(deadBag.summary).toMatch(/post-ATH/);
  });

  it('does NOT dead-bag damp fresh tokens still in their first run', () => {
    const fresh = computeHotTokenScore(
      baseline({
        priceChange1h: 40,
        marketCapUsd: 100_000, athMarketCapUsd: 500_000,
        pairAgeHours: 1, // < 4h floor
      }),
      'meme_hunter',
    );
    expect(fresh.summary).not.toMatch(/post-ATH/);
  });

  // ── Phase 3: Twitter mention signals ────────────────────────────────────
  it('rewards tokens with high project-aligned Twitter mentions', () => {
    const quiet = computeHotTokenScore(
      baseline({
        priceChange1h: 20, marketCapUsd: 100_000,
        twitterAlignedMatches: 0, twitterUniqueAuthors: 0, twitterCallerFollowerLog: 0,
      }),
      'meme_hunter',
    );
    const buzzing = computeHotTokenScore(
      baseline({
        priceChange1h: 20, marketCapUsd: 100_000,
        twitterAlignedMatches: 60, twitterUniqueAuthors: 25, twitterCallerFollowerLog: 30,
      }),
      'meme_hunter',
    );
    // +10 (>=50 posts) + 6 (KOL log >=25) + 3 (>=15 authors) = +19 minimum
    expect(buzzing.score - quiet.score).toBeGreaterThanOrEqual(19);
    expect(buzzing.summary).toMatch(/posts|KOL|authors/);
  });

  it('does NOT boost a token with zero aligned tweets even if total search count is high', () => {
    // Sentiment-only shill noise — passes raw search but no narrative match
    const r = computeHotTokenScore(
      baseline({
        priceChange1h: 20,
        twitterAlignedMatches: 0,
        twitterUniqueAuthors: 0,
        twitterCallerFollowerLog: 0,
      }),
      'meme_hunter',
    );
    expect(r.summary).not.toMatch(/posts|KOL|team active/);
  });

  it('gives a small bonus when the project handle tweeted recently', () => {
    const active = computeHotTokenScore(
      baseline({ priceChange1h: 10, twitterProjectActive: true }),
      'meme_hunter',
    );
    const inactive = computeHotTokenScore(
      baseline({ priceChange1h: 10, twitterProjectActive: false }),
      'meme_hunter',
    );
    expect(active.score - inactive.score).toBeGreaterThanOrEqual(3);
  });

  it('backwards-compat: undefined Twitter fields produce identical score to old callers', () => {
    const old = computeHotTokenScore(
      baseline({ priceChange1h: 30, marketCapUsd: 100_000 }),
      'meme_hunter',
    );
    const explicit = computeHotTokenScore(
      baseline({
        priceChange1h: 30, marketCapUsd: 100_000,
        twitterAlignedMatches: undefined, twitterUniqueAuthors: undefined,
        twitterCallerFollowerLog: undefined, twitterProjectActive: undefined,
      }),
      'meme_hunter',
    );
    expect(old.score).toBe(explicit.score);
  });
});
