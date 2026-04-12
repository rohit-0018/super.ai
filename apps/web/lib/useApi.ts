'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import { api } from './api';
import { useAuth } from './auth-store';

/**
 * Shared-fetch hook with in-flight dedupe, module-level cache, and pub/sub.
 *
 * Why: multiple components on the same page used to each call useEffect(() =>
 * api.get('/wallets')). With N components that's N network calls for the same
 * data. This hook collapses them into a single in-flight request and a single
 * cached result keyed by the URL path.
 *
 * Usage:
 *   const { data, loading, error, refresh } = useApi<Wallet[]>('/wallets');
 *
 * Options:
 *   - auth: boolean (default true) — only fetch when user is signed in
 *   - pollMs: number — re-fetch on an interval (shared across subscribers)
 *   - ttlMs: number — stale-while-revalidate window (default 3s)
 */

interface Entry<T = any> {
  data: T | undefined;
  error: string | null;
  promise: Promise<T> | null;
  fetchedAt: number;
  subscribers: Set<() => void>;
  pollTimer?: ReturnType<typeof setInterval>;
  pollMs?: number;
}

const cache = new Map<string, Entry>();

function getEntry<T>(key: string): Entry<T> {
  let e = cache.get(key) as Entry<T> | undefined;
  if (!e) {
    e = { data: undefined, error: null, promise: null, fetchedAt: 0, subscribers: new Set() };
    cache.set(key, e);
  }
  return e;
}

function notify(entry: Entry) {
  entry.subscribers.forEach((fn) => fn());
}

async function doFetch<T>(key: string, entry: Entry<T>): Promise<T> {
  if (entry.promise) return entry.promise;
  entry.promise = (async () => {
    try {
      const resp = await api.get<T>(key);
      entry.data = resp.data;
      entry.error = null;
      entry.fetchedAt = Date.now();
      return resp.data;
    } catch (e: any) {
      entry.error = e?.message ?? 'Fetch failed';
      throw e;
    } finally {
      entry.promise = null;
      notify(entry);
    }
  })();
  return entry.promise;
}

/** Imperative: invalidate a cached entry so the next subscriber re-fetches. */
export function invalidate(key: string) {
  const e = cache.get(key);
  if (!e) return;
  e.fetchedAt = 0;
  e.data = undefined;
  doFetch(key, e).catch(() => {});
}

/** Imperative: optimistically update a cached entry and broadcast. */
export function mutate<T>(key: string, updater: (prev: T | undefined) => T) {
  const e = cache.get(key) as Entry<T> | undefined;
  if (!e) return;
  e.data = updater(e.data);
  e.fetchedAt = Date.now();
  notify(e);
}

interface UseApiOpts {
  auth?: boolean;
  pollMs?: number;
  ttlMs?: number;
  enabled?: boolean;
}

export function useApi<T = any>(
  path: string,
  opts: UseApiOpts = {},
): {
  data: T | undefined;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const { auth = true, pollMs, ttlMs = 3000, enabled = true } = opts;
  const { accessToken, hydrated } = useAuth();
  const [, setTick] = useState(0);
  const mounted = useRef(true);

  const ready = enabled && (!auth || (hydrated && !!accessToken));

  const refresh = useCallback(async () => {
    if (!ready) return;
    const entry = getEntry<T>(path);
    entry.fetchedAt = 0;
    try { await doFetch<T>(path, entry); } catch {}
  }, [ready, path]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const entry = getEntry<T>(path);
    const force = () => { if (mounted.current) setTick((t) => t + 1); };
    entry.subscribers.add(force);

    const fresh = Date.now() - entry.fetchedAt < ttlMs;
    if (entry.data === undefined || !fresh) {
      doFetch<T>(path, entry).catch(() => {});
    }

    // Poll management — shared across all subscribers of this key.
    if (pollMs && (!entry.pollTimer || entry.pollMs !== pollMs)) {
      if (entry.pollTimer) clearInterval(entry.pollTimer);
      entry.pollMs = pollMs;
      entry.pollTimer = setInterval(() => {
        if (entry.subscribers.size > 0) doFetch<T>(path, entry).catch(() => {});
      }, pollMs);
    }

    return () => {
      entry.subscribers.delete(force);
      if (entry.subscribers.size === 0 && entry.pollTimer) {
        clearInterval(entry.pollTimer);
        entry.pollTimer = undefined;
        entry.pollMs = undefined;
      }
    };
  }, [ready, path, pollMs, ttlMs]);

  const entry = cache.get(path) as Entry<T> | undefined;
  return {
    data: entry?.data,
    loading: !entry || (entry.data === undefined && !entry.error),
    error: entry?.error ?? null,
    refresh,
  };
}
