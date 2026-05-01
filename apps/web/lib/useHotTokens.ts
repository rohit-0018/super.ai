'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from './api';
import { useRealtime } from './useRealtime';

export interface HotToken {
  address: string;
  symbol: string;
  name: string;
  chain: 'SOLANA';
  priceUsd: number;
  priceChange5m: number;
  priceChange1h: number;
  priceChange24h: number;
  volume24hUsd: number;
  marketCapUsd: number;
  liquidityUsd: number;
  pairAgeHours: number;
  source: 'pumpfun' | 'dexscreener_boost' | 'dexscreener_profile';
  launchPlatform?: string;
  score: number;
  verdict: 'STRONG_BUY' | 'BUY' | 'CAUTIOUS' | 'SKIP' | 'HIGH_RISK';
  summary: string;
  dexUrl?: string;
  profileKey: string;
  scannedAt: string;
}

export interface HotTokensScan {
  tokens: HotToken[];
  profileKey: string;
  scannedAt: string | null;
  nextScanAt: string | null;
  scanIntervalMs: number;
  fastScanEnabled: boolean;
}

function getStoredProfile(): string {
  try { return localStorage.getItem('qwai_profile') ?? 'meme_hunter'; } catch { return 'meme_hunter'; }
}

export function useHotTokens() {
  const [scan, setScan] = useState<HotTokensScan | null>(null);
  const [loading, setLoading] = useState(true);
  const profileRef = useRef(getStoredProfile());

  const fetchLatest = useCallback(async () => {
    try {
      const profile = getStoredProfile();
      profileRef.current = profile;
      const res = await api.get<HotTokensScan>(`/hot-tokens?profile=${profile}`);
      if (res.data) setScan(res.data);
    } catch {
      // keep previous data on error
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch + poll every 2 min as fallback to WS
  useEffect(() => {
    fetchLatest();
    const timer = setInterval(fetchLatest, 2 * 60 * 1000);
    return () => clearInterval(timer);
  }, [fetchLatest]);

  // WS: full scan update (new discovery + scores)
  useRealtime('hot_tokens_update', (data: { byProfile: Record<string, HotToken[]>; scannedAt: string; nextScanAt: string; scanIntervalMs: number }) => {
    const profile = getStoredProfile();
    const tokens = data.byProfile?.[profile] ?? [];
    setScan({
      tokens,
      profileKey: profile,
      scannedAt: data.scannedAt,
      nextScanAt: data.nextScanAt,
      scanIntervalMs: data.scanIntervalMs,
      fastScanEnabled: false,
    });
  });

  // WS: lightweight price refresh (only updates prices in existing token list)
  useRealtime('hot_tokens_refresh', (data: { tokens: Array<Pick<HotToken, 'address' | 'priceUsd' | 'priceChange1h' | 'priceChange5m' | 'volume24hUsd'>>; refreshedAt: string }) => {
    setScan((prev) => {
      if (!prev) return prev;
      const byAddr = new Map(data.tokens.map((t) => [t.address, t]));
      return {
        ...prev,
        tokens: prev.tokens.map((t) => {
          const fresh = byAddr.get(t.address);
          if (!fresh) return t;
          return { ...t, priceUsd: fresh.priceUsd, priceChange1h: fresh.priceChange1h, priceChange5m: fresh.priceChange5m, volume24hUsd: fresh.volume24hUsd };
        }),
      };
    });
  });

  const nextScanMs = scan?.nextScanAt ? Math.max(0, new Date(scan.nextScanAt).getTime() - Date.now()) : null;

  return { scan, loading, refresh: fetchLatest, nextScanMs };
}
