'use client';
import { useCallback, useRef, useState } from 'react';
import { api } from './api';

export type Chain = 'SOLANA' | 'EVM';

export interface ResolvedToken {
  chain: Chain;
  chainId: string;
  address: string;
  symbol: string;
  name: string;
  priceUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  pairAgeHours: number | null;
  txns24h: number | null;
  logoURI: string | null;
  url: string | null;
  verified: boolean;
  score: number;
  matchTier: 'address' | 'exact' | 'prefix' | 'fuzzy';
}

export interface ResolveResult {
  kind: 'address' | 'ticker' | 'unresolvable';
  query: string;
  best: ResolvedToken | null;
  candidates: ResolvedToken[];
  ambiguous: boolean;
  confidence: number;
}

interface ResolveOpts {
  chain?: Chain;
  limit?: number;
  minLiquidityUsd?: number;
}

/**
 * Calls GET /api/resolve. Single-flight: a newer call supersedes an in-flight
 * one so fast typing can't render a stale result. Never throws — failures
 * surface as `error` and an empty result.
 */
export function useTokenResolve() {
  const [result, setResult] = useState<ResolveResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const resolve = useCallback(async (q: string, opts: ResolveOpts = {}) => {
    const query = q.trim();
    const mySeq = ++seq.current;
    if (!query) {
      setResult(null);
      setError(null);
      setLoading(false);
      return null;
    }
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ q: query });
      if (opts.chain) params.set('chain', opts.chain);
      if (opts.limit) params.set('limit', String(opts.limit));
      if (opts.minLiquidityUsd != null) params.set('minLiquidityUsd', String(opts.minLiquidityUsd));
      const res = await api.get<ResolveResult>(`/resolve?${params.toString()}`);
      if (mySeq !== seq.current) return null; // superseded by a newer query
      setResult(res.data);
      setLoading(false);
      return res.data;
    } catch (e: any) {
      if (mySeq !== seq.current) return null;
      setError(e?.response?.data?.message ?? e?.message ?? 'Lookup failed');
      setResult(null);
      setLoading(false);
      return null;
    }
  }, []);

  const reset = useCallback(() => {
    seq.current++;
    setResult(null);
    setError(null);
    setLoading(false);
  }, []);

  return { resolve, reset, result, loading, error };
}
