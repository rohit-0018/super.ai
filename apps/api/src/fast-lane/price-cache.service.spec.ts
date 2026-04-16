import { PriceCacheService } from './price-cache.service';

function makeConfig(overrides: Record<string, string> = {}): any {
  const defaults: Record<string, string> = {
    FAST_LANE_SKIP_QUOTE_IF_FRESH: 'true',
    FAST_LANE_PRICE_CACHE_TTL_MS: '5000',
    ...overrides,
  };
  return {
    get: jest.fn((key: string, fallback?: string) => defaults[key] ?? fallback),
  };
}

function makeMarketData(price: number | null = 1.5): any {
  return { price: jest.fn().mockResolvedValue(price) };
}

describe('PriceCacheService', () => {
  describe('basic get/set', () => {
    it('set() stores price with updatedAt timestamp; get() returns it', () => {
      const svc = new PriceCacheService(makeConfig(), makeMarketData());
      svc.set('SOL', 100, 'birdeye');
      const entry = svc.get('SOL');
      expect(entry).not.toBeNull();
      expect(entry!.price).toBe(100);
      expect(entry!.source).toBe('birdeye');
      expect(entry!.token).toBe('SOL');
      expect(entry!.ageMs).toBeGreaterThanOrEqual(0);
    });

    it('get() returns null if not cached', () => {
      const svc = new PriceCacheService(makeConfig(), makeMarketData());
      expect(svc.get('UNKNOWN')).toBeNull();
    });
  });

  describe('TTL / freshness', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('get() returns null if entry is older than TTL', () => {
      const svc = new PriceCacheService(makeConfig(), makeMarketData());
      svc.set('SOL', 100);
      expect(svc.get('SOL')).not.toBeNull();
      jest.advanceTimersByTime(6000); // > 5000 TTL
      expect(svc.get('SOL')).toBeNull();
    });

    it('get() returns entry if still fresh', () => {
      const svc = new PriceCacheService(makeConfig(), makeMarketData());
      svc.set('SOL', 100);
      jest.advanceTimersByTime(2000); // < 5000 TTL
      expect(svc.get('SOL')).not.toBeNull();
    });

    it('isFresh() reflects age vs TTL', () => {
      const svc = new PriceCacheService(makeConfig(), makeMarketData());
      svc.set('SOL', 100);
      expect(svc.isFresh('SOL')).toBe(true);
      jest.advanceTimersByTime(6000);
      expect(svc.isFresh('SOL')).toBe(false);
    });

    it('isFresh() respects custom maxAgeMs override', () => {
      const svc = new PriceCacheService(makeConfig(), makeMarketData());
      svc.set('SOL', 100);
      jest.advanceTimersByTime(2000);
      expect(svc.isFresh('SOL', 1000)).toBe(false);
      expect(svc.isFresh('SOL', 3000)).toBe(true);
    });

    it('isFresh() returns false for unknown token', () => {
      const svc = new PriceCacheService(makeConfig(), makeMarketData());
      expect(svc.isFresh('UNKNOWN')).toBe(false);
    });
  });

  describe('computeMinOut', () => {
    it('returns expected minOut for fresh price', () => {
      const svc = new PriceCacheService(makeConfig(), makeMarketData());
      svc.set('SOL', 100); // 1 SOL = $100
      // amountInUsd = 200, so expectedOut = 2 SOL, slippage 1% (100 bps) -> 1.98
      const minOut = svc.computeMinOut('SOL', 200, 100);
      expect(minOut).toBeCloseTo(1.98, 5);
    });

    it('returns null for stale/missing price', () => {
      jest.useFakeTimers();
      const svc = new PriceCacheService(makeConfig(), makeMarketData());
      svc.set('SOL', 100);
      jest.advanceTimersByTime(6000);
      expect(svc.computeMinOut('SOL', 200, 100)).toBeNull();
      expect(svc.computeMinOut('UNKNOWN', 200, 100)).toBeNull();
      jest.useRealTimers();
    });
  });

  describe('fetchAndCache / getOrFetch', () => {
    it('fetchAndCache() calls marketData.price and stores result', async () => {
      const md = makeMarketData(42);
      const svc = new PriceCacheService(makeConfig(), md);
      const price = await svc.fetchAndCache('SOL');
      expect(price).toBe(42);
      expect(md.price).toHaveBeenCalledWith('SOL');
      expect(svc.get('SOL')!.price).toBe(42);
    });

    it('fetchAndCache() returns null when marketData returns null', async () => {
      const md = makeMarketData(null);
      const svc = new PriceCacheService(makeConfig(), md);
      const price = await svc.fetchAndCache('SOL');
      expect(price).toBeNull();
      expect(svc.get('SOL')).toBeNull();
    });

    it('fetchAndCache() returns null on marketData error', async () => {
      const md: any = { price: jest.fn().mockRejectedValue(new Error('fail')) };
      const svc = new PriceCacheService(makeConfig(), md);
      const price = await svc.fetchAndCache('SOL');
      expect(price).toBeNull();
    });

    it('getOrFetch() returns cached price if available without fetching', async () => {
      const md = makeMarketData(99);
      const svc = new PriceCacheService(makeConfig(), md);
      svc.set('SOL', 100, 'birdeye');
      const price = await svc.getOrFetch('SOL');
      expect(price).toBe(100);
      expect(md.price).not.toHaveBeenCalled();
    });

    it('getOrFetch() fetches when not cached', async () => {
      const md = makeMarketData(77);
      const svc = new PriceCacheService(makeConfig(), md);
      const price = await svc.getOrFetch('SOL');
      expect(price).toBe(77);
      expect(md.price).toHaveBeenCalledWith('SOL');
    });
  });

  describe('eviction / snapshot / clear', () => {
    it('snapshot() returns all entries with ageMs', () => {
      const svc = new PriceCacheService(makeConfig(), makeMarketData());
      svc.set('SOL', 100);
      svc.set('BONK', 0.00001);
      const snap = svc.snapshot();
      expect(snap).toHaveLength(2);
      const tokens = snap.map((e) => e.token).sort();
      expect(tokens).toEqual(['BONK', 'SOL']);
      for (const e of snap) {
        expect(e.ageMs).toBeGreaterThanOrEqual(0);
      }
    });

    it('clear() empties the cache', () => {
      const svc = new PriceCacheService(makeConfig(), makeMarketData());
      svc.set('SOL', 100);
      svc.set('BONK', 0.00001);
      svc.clear();
      expect(svc.snapshot()).toHaveLength(0);
      expect(svc.getHotTokens()).toHaveLength(0);
    });

    it('set() evicts oldest entry when cache is at maxCacheSize (500)', () => {
      const svc = new PriceCacheService(makeConfig(), makeMarketData());
      // Fill to maxCacheSize (500)
      for (let i = 0; i < 500; i++) {
        svc.set(`tok-${i}`, i);
      }
      expect(svc.snapshot()).toHaveLength(500);
      // The first inserted token should still be present
      expect(svc.get('tok-0')).not.toBeNull();
      // Adding a new token should evict the oldest (tok-0)
      svc.set('new-token', 1);
      expect(svc.snapshot()).toHaveLength(500);
      expect(svc.get('tok-0')).toBeNull();
      expect(svc.get('new-token')).not.toBeNull();
    });

    it('set() updates existing entry without eviction', () => {
      const svc = new PriceCacheService(makeConfig(), makeMarketData());
      svc.set('SOL', 100);
      svc.set('SOL', 200);
      expect(svc.get('SOL')!.price).toBe(200);
      expect(svc.snapshot()).toHaveLength(1);
    });

    it('set() adds token to hotTokens set', () => {
      const svc = new PriceCacheService(makeConfig(), makeMarketData());
      svc.set('SOL', 100);
      svc.set('BONK', 0.00001);
      const hot = svc.getHotTokens();
      expect(hot).toContain('SOL');
      expect(hot).toContain('BONK');
    });
  });

  describe('config getters', () => {
    it('isSkipQuoteEnabled() and getTtlMs() reflect config', () => {
      const svc = new PriceCacheService(
        makeConfig({
          FAST_LANE_SKIP_QUOTE_IF_FRESH: 'false',
          FAST_LANE_PRICE_CACHE_TTL_MS: '8000',
        }),
        makeMarketData(),
      );
      expect(svc.isSkipQuoteEnabled()).toBe(false);
      expect(svc.getTtlMs()).toBe(8000);
    });
  });
});
