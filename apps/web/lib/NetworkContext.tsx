'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useApi } from './useApi';

/**
 * Global network selection.
 *
 * One selected network drives every chain-aware surface (token feed, wallets,
 * buy/sell), so it lives in context rather than per-page state — otherwise
 * navigating from the feed to wallets would silently reset which chain you are
 * looking at.
 *
 * The choice is persisted to localStorage so a reload keeps the user where they
 * were, and the network list comes from the API rather than being hardcoded,
 * so adding a chain to the backend registry surfaces it here automatically.
 */

export type NetworkKey = string; // 'all' | ChainKey

export interface NetworkOption {
  key: NetworkKey;
  name: string;
  family?: 'SOLANA' | 'EVM';
  evmChainId?: number;
  nativeSymbol?: string;
  count: number;
}

interface NetworkCtx {
  network: NetworkKey;
  setNetwork: (k: NetworkKey) => void;
  options: NetworkOption[];
  /** The selected option, or undefined while the list is still loading. */
  selected?: NetworkOption;
  loading: boolean;
  isAll: boolean;
}

const STORAGE_KEY = 'qwai_network';

const Ctx = createContext<NetworkCtx>({
  network: 'all',
  setNetwork: () => {},
  options: [],
  loading: true,
  isAll: true,
});

export function NetworkProvider({ children }: { children: ReactNode }) {
  const [network, setNetworkState] = useState<NetworkKey>('all');
  const { data, loading } = useApi<{ networks: NetworkOption[] }>('/venues/networks', {
    // Public endpoint — served from the in-memory feed snapshot, so polling is
    // cheap. Counts drift as the scanner runs, so refresh often enough to feel
    // live without hammering it.
    auth: false,
    pollMs: 30_000,
  });

  // Restore after mount so server and first client render agree (no hydration mismatch).
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) setNetworkState(saved);
    } catch {
      /* localStorage unavailable — fall back to the default */
    }
  }, []);

  const setNetwork = useCallback((k: NetworkKey) => {
    setNetworkState(k);
    try {
      localStorage.setItem(STORAGE_KEY, k);
    } catch {
      /* non-fatal */
    }
  }, []);

  const options = data?.networks ?? [];

  const value = useMemo<NetworkCtx>(
    () => ({
      network,
      setNetwork,
      options,
      selected: options.find((o) => o.key === network),
      loading,
      isAll: network === 'all',
    }),
    [network, setNetwork, options, loading],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useNetwork() {
  return useContext(Ctx);
}

/**
 * Query-string fragment for the selected network, e.g. `network=base`.
 * Returns an empty string for `all` so callers can append unconditionally.
 */
export function networkParam(network: NetworkKey): string {
  return network && network !== 'all' ? `network=${encodeURIComponent(network)}` : '';
}
