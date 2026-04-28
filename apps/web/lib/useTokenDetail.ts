'use client';
import { useEffect, useRef, useState } from 'react';
import { useApi } from './useApi';

export interface TokenDetail {
  mint: string;
  name: string | null;
  symbol: string | null;
  logoURI: string | null;
  decimals: number | null;
  priceUsd: number | null;
  priceChange24hPct: number | null;
  marketCap: number | null;
  fdv: number | null;
  liquidity: number | null;
  volume24hUsd: number | null;
  supply: number | null;
  holders: number | null;
  source: 'birdeye' | 'unknown';
  fetchedAt: string;
}

/**
 * Lazy IntersectionObserver hook. Fires once when the element enters the
 * viewport (sticky), 120px rootMargin so we start fetching just before scroll-in.
 */
export function useInView<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    if (inView) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          obs.disconnect();
        }
      },
      { rootMargin: '120px 0px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [inView]);

  return { ref, inView };
}

/**
 * Lazy token detail fetch — only fires when `enabled` flips true.
 * Cached server-side (60s) and in useApi's module cache, so re-renders + mints
 * shared across rows dedupe to a single fetch.
 */
export function useTokenDetail(mint: string, enabled: boolean) {
  return useApi<TokenDetail>(`/market/tokens/${mint}`, { enabled, ttlMs: 60_000 });
}
