import { PerformanceTracker } from './performance-tracker';

function busyWait(ms: number) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    // spin
  }
}

describe('PerformanceTracker', () => {
  describe('mark()', () => {
    it('records a checkpoint with name, absoluteMs, deltaMs, cumulativeMs', () => {
      const t = new PerformanceTracker();
      t.mark('first');
      const r = t.report();
      expect(r.checkpoints).toHaveLength(1);
      const cp = r.checkpoints[0];
      expect(cp.name).toBe('first');
      expect(typeof cp.absoluteMs).toBe('number');
      expect(typeof cp.deltaMs).toBe('number');
      expect(typeof cp.cumulativeMs).toBe('number');
      expect(cp.absoluteMs).toBeGreaterThan(0);
      expect(cp.deltaMs).toBeGreaterThanOrEqual(0);
      expect(cp.cumulativeMs).toBeGreaterThanOrEqual(0);
    });

    it('multiple marks accumulate correctly', () => {
      const t = new PerformanceTracker();
      t.mark('a');
      busyWait(5);
      t.mark('b');
      busyWait(5);
      t.mark('c');
      const r = t.report();
      expect(r.checkpoints).toHaveLength(3);
      expect(r.checkpoints.map((c) => c.name)).toEqual(['a', 'b', 'c']);
    });
  });

  describe('totalMs()', () => {
    it('returns elapsed time since construction', () => {
      const t = new PerformanceTracker();
      busyWait(10);
      const total = t.totalMs();
      expect(total).toBeGreaterThanOrEqual(9);
    });

    it('still works with empty checkpoints', () => {
      const t = new PerformanceTracker();
      const total = t.totalMs();
      expect(typeof total).toBe('number');
      expect(total).toBeGreaterThanOrEqual(0);
    });
  });

  describe('report()', () => {
    it('returns a full PerfReport with tradeId, channel, totalMs, checkpoints, timestamps', () => {
      const t = new PerformanceTracker();
      t.setMeta('trade-1', 'web');
      t.mark('one');
      const r = t.report();
      expect(r.tradeId).toBe('trade-1');
      expect(r.channel).toBe('web');
      expect(typeof r.totalMs).toBe('number');
      expect(Array.isArray(r.checkpoints)).toBe(true);
      expect(typeof r.startedAt).toBe('string');
      expect(typeof r.finishedAt).toBe('string');
      // ISO timestamps
      expect(() => new Date(r.startedAt).toISOString()).not.toThrow();
      expect(() => new Date(r.finishedAt).toISOString()).not.toThrow();
    });
  });

  describe('setMeta()', () => {
    it('sets tradeId and channel', () => {
      const t = new PerformanceTracker();
      t.setMeta('tx-42', 'telegram');
      const r = t.report();
      expect(r.tradeId).toBe('tx-42');
      expect(r.channel).toBe('telegram');
    });

    it('defaults to empty strings before setMeta is called', () => {
      const t = new PerformanceTracker();
      const r = t.report();
      expect(r.tradeId).toBe('');
      expect(r.channel).toBe('');
    });
  });

  describe('delta and cumulative calculations', () => {
    it('2nd checkpoint deltaMs roughly matches gap between 1st and 2nd', () => {
      const t = new PerformanceTracker();
      t.mark('first');
      busyWait(15);
      t.mark('second');
      const r = t.report();
      // 2nd delta should be around 15ms (allow jitter)
      expect(r.checkpoints[1].deltaMs).toBeGreaterThanOrEqual(10);
    });

    it('Nth cumulativeMs is monotonically increasing from start', () => {
      const t = new PerformanceTracker();
      t.mark('a');
      busyWait(5);
      t.mark('b');
      busyWait(5);
      t.mark('c');
      const r = t.report();
      expect(r.checkpoints[0].cumulativeMs).toBeLessThanOrEqual(r.checkpoints[1].cumulativeMs);
      expect(r.checkpoints[1].cumulativeMs).toBeLessThanOrEqual(r.checkpoints[2].cumulativeMs);
      // 3rd cumulative >= sum of waits
      expect(r.checkpoints[2].cumulativeMs).toBeGreaterThanOrEqual(9);
    });

    it('first checkpoint cumulativeMs ~= deltaMs', () => {
      const t = new PerformanceTracker();
      t.mark('only');
      const r = t.report();
      const cp = r.checkpoints[0];
      // First mark — delta and cumulative measure from start (within tiny epsilon)
      expect(Math.abs(cp.deltaMs - cp.cumulativeMs)).toBeLessThan(1);
    });
  });
});
