'use client';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';
import { useRealtime } from './useRealtime';

export interface PoolLiveData {
  priceUsd: number;
  marketCapUsd: number;
  priceChange1h: number;
  priceChange5m: number;
  volume24hUsd: number;
  liquidityUsd: number;
  lastRefreshed: string;
}

type PoolMap = Record<string, PoolLiveData>;

interface PoolUpdate {
  updates: Record<string, PoolLiveData>;
  archivedAddresses: string[];
  refreshedAt: string;
}

// REST fallback poll interval. Mirrors TOKEN_POOL_REFRESH_MINS on the server (default 2 min).
const POOL_REFRESH_MINS = parseInt(process.env.NEXT_PUBLIC_TOKEN_POOL_REFRESH_MINS ?? '2', 10);
const POLL_MS = POOL_REFRESH_MINS * 60_000;

const TokenPoolContext = createContext<PoolMap>({});

export function useTokenPool(): PoolMap {
  return useContext(TokenPoolContext);
}

/**
 * Provides a shared live-price map to all descendant components.
 * Mount once near the root (AppShell). Every card reads from this
 * context instead of issuing individual REST requests.
 */
export function TokenPoolProvider({ children }: { children: ReactNode }) {
  const [pool, setPool] = useState<PoolMap>({});

  // Initial hydration + polling fallback
  useEffect(() => {
    const load = () =>
      api
        .get<{ entries: PoolMap }>('/hot-tokens/pool')
        .then((res) => { if (res.data?.entries) setPool(res.data.entries); })
        .catch(() => {});

    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, []);

  // Real-time deltas from the server pool refresh
  useRealtime('pool_update', (data: PoolUpdate) => {
    if (!data?.updates) return;
    setPool((prev) => {
      const next = { ...prev, ...data.updates };
      for (const addr of data.archivedAddresses ?? []) delete next[addr];
      return next;
    });
  });

  return <TokenPoolContext.Provider value={pool}>{children}</TokenPoolContext.Provider>;
}
