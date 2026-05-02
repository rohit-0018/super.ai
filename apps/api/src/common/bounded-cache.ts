/**
 * BoundedCache — LRU + TTL Map replacement.
 *
 * Several services in this codebase used `private cache = new Map<...>()`
 * with a TTL check on read but no size bound. On Render free plan (512MB)
 * those grow to fill all available heap because:
 *
 *   - TTLs only filter on READ — entries that are never read again sit
 *     forever as garbage, not even visible to V8's GC because the Map
 *     still references them.
 *   - Token analysis reports are 50–200KB each; a few hundred mints
 *     scanned in a day = 50MB silently lost.
 *   - One-off keys (e.g. recently-pumped tokens that won't be looked up
 *     again) accumulate without ever being evicted.
 *
 * BoundedCache fixes both problems:
 *   1. `max` cap with LRU eviction — when set() exceeds the cap, the
 *      oldest entry (insertion-order in V8 Maps) is dropped.
 *   2. `ttlMs` per-entry — get() returns undefined and lazily deletes
 *      expired entries.
 *
 * Both knobs are tunable per-service. Using insertion-order Map keys
 * gives us LRU on writes; on reads we delete + reinsert to bump
 * recency. That's O(1) per op.
 */
export class BoundedCache<K, V> {
  private store = new Map<K, { value: V; ts: number }>();

  constructor(
    private readonly max: number,
    private readonly ttlMs: number,
  ) {}

  get(key: K): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > this.ttlMs) {
      this.store.delete(key);
      return undefined;
    }
    // Bump recency: re-insert so LRU eviction protects hot keys.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { value, ts: Date.now() });
    if (this.store.size > this.max) {
      // First key in insertion order = oldest = LRU victim.
      const oldest = this.store.keys().next().value as K;
      this.store.delete(oldest);
    }
  }

  delete(key: K): boolean {
    return this.store.delete(key);
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }

  /** Drop every expired entry. Call from a janitor interval if you want. */
  prune(): number {
    const now = Date.now();
    let dropped = 0;
    for (const [k, v] of this.store) {
      if (now - v.ts > this.ttlMs) {
        this.store.delete(k);
        dropped++;
      }
    }
    return dropped;
  }

  /** Iterate raw entries — used for prefix-based invalidation. */
  *keys(): IterableIterator<K> {
    for (const k of this.store.keys()) yield k;
  }
}
