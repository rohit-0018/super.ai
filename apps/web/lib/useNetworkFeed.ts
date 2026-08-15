'use client';
import { useMemo } from 'react';
import { useApi } from './useApi';
import { useNetwork } from './NetworkContext';
import { useHotTokens, type HotToken } from './useHotTokens';

/**
 * One token feed that follows the selected network.
 *
 * Two upstreams, deliberately combined rather than replaced:
 *
 *  - The Solana scanner (`/hot-tokens`) is *richer* — it carries heuristic
 *    scores, verdicts, summaries and live WS updates that no other chain has.
 *    Throwing it away to get multi-chain uniformity would be a downgrade.
 *  - The venue feed (`/venues/feed`) is *broader* — every registered chain,
 *    but no scoring.
 *
 * So: Solana rows keep their score/verdict, other chains render without one,
 * and `all` merges both — preferring the scored row when the same token appears
 * in each. That way picking a network never loses information you already had.
 */

export interface UnifiedToken {
  chain: string;
  chainName: string;
  address: string;
  symbol: string;
  name: string;
  priceUsd: number;
  priceChange5m?: number;
  priceChange1h?: number;
  priceChange24h?: number;
  volume24hUsd: number;
  liquidityUsd: number;
  marketCapUsd?: number;
  pairAgeHours?: number;
  source: string;
  dexUrl?: string;
  imageUrl?: string;
  tradable: boolean;
  /** Solana scanner only — absent on other chains. */
  score?: number;
  verdict?: HotToken['verdict'];
  summary?: string;
  launchPlatform?: string;
}

interface FeedResponse {
  tokens: Array<Omit<UnifiedToken, 'score' | 'verdict' | 'summary'>>;
  countsByChain: Record<string, number>;
  network: string;
  fetchedAt: string;
  stale: boolean;
}

const CHAIN_DISPLAY: Record<string, string> = {
  solana: 'Solana',
  ethereum: 'Ethereum',
  bsc: 'BNB Chain',
  base: 'Base',
  arbitrum: 'Arbitrum',
  polygon: 'Polygon',
  avalanche: 'Avalanche',
  optimism: 'Optimism',
  blast: 'Blast',
};

/** Normalizes a scanner row (always Solana) into the unified shape. */
function fromHotToken(t: HotToken): UnifiedToken {
  return {
    chain: 'solana',
    chainName: 'Solana',
    address: t.address,
    symbol: t.symbol,
    name: t.name,
    priceUsd: t.priceUsd,
    priceChange5m: t.priceChange5m,
    priceChange1h: t.priceChange1h,
    priceChange24h: t.priceChange24h,
    volume24hUsd: t.volume24hUsd,
    liquidityUsd: t.liquidityUsd,
    marketCapUsd: t.marketCapUsd,
    pairAgeHours: t.pairAgeHours,
    source: t.source,
    dexUrl: t.dexUrl,
    tradable: true,
    score: t.score,
    verdict: t.verdict,
    summary: t.summary,
    launchPlatform: t.launchPlatform,
  };
}

export interface NetworkFeed {
  tokens: UnifiedToken[];
  loading: boolean;
  /** Per-chain counts from the venue feed — powers badges. */
  countsByChain: Record<string, number>;
  network: string;
  /** True when the selected network has no rows yet (not the same as loading). */
  empty: boolean;
  stale: boolean;
  refresh: () => void;
}

export function useNetworkFeed(limit = 100): NetworkFeed {
  const { network } = useNetwork();
  const hot = useHotTokens();

  // The venue feed is only needed when the view isn't Solana-only — on Solana
  // the scanner already covers it with strictly more information.
  const needsVenueFeed = network !== 'solana';

  /**
   * Routed through useApi rather than a local fetch + setInterval.
   *
   * useApi keys its cache by path and single-flights concurrent callers, so the
   * bar, the feed page and anything else mounting this hook share ONE request
   * and ONE poll timer. With a private fetch here, a dashboard load fired
   * /venues/feed three times — once per consumer plus a re-run when the network
   * hydrated from localStorage.
   */
  const { data: feed, loading: loadingFeed, refresh: refetch } = useApi<FeedResponse>(
    `/venues/feed?network=${encodeURIComponent(network)}&limit=${limit}`,
    {
      auth: false,
      enabled: needsVenueFeed,
      // Server rescans every ~45s; poll a little slower than that.
      pollMs: 30_000,
      ttlMs: 15_000,
    },
  );

  const tokens = useMemo<UnifiedToken[]>(() => {
    const scanner = (hot.scan?.tokens ?? []).map(fromHotToken);

    if (network === 'solana') return scanner;

    const venue: UnifiedToken[] = (feed?.tokens ?? []).map((t) => ({
      ...t,
      chainName: t.chainName ?? CHAIN_DISPLAY[t.chain] ?? t.chain,
    }));

    if (network !== 'all') return venue;

    // `all`: merge, letting the scored Solana row win on collision.
    const byKey = new Map<string, UnifiedToken>();
    for (const t of venue) byKey.set(`${t.chain}:${t.address.toLowerCase()}`, t);
    for (const t of scanner) {
      const k = `solana:${t.address.toLowerCase()}`;
      const existing = byKey.get(k);
      // Merge rather than overwrite so we keep venue-only fields (imageUrl).
      byKey.set(k, existing ? { ...existing, ...t } : t);
    }

    return [...byKey.values()].sort((a, b) => b.volume24hUsd - a.volume24hUsd);
  }, [network, feed, hot.scan]);

  const loading = network === 'solana' ? hot.loading : loadingFeed && !feed;

  return {
    tokens,
    loading,
    countsByChain: feed?.countsByChain ?? {},
    network,
    empty: !loading && tokens.length === 0,
    stale: feed?.stale ?? false,
    refresh: refetch,
  };
}

/** Brand-recognisable chain colours, shared by every chain-tagged surface. */
export const CHAIN_COLOR: Record<string, string> = {
  solana: '#14F195',
  ethereum: '#627EEA',
  bsc: '#F0B90B',
  base: '#0052FF',
  arbitrum: '#12AAFF',
  polygon: '#8247E5',
  avalanche: '#E84142',
  optimism: '#FF0420',
  blast: '#FCFC03',
};

export function chainColor(chain: string): string {
  return CHAIN_COLOR[chain] ?? 'var(--text-3)';
}

export function chainName(chain: string): string {
  return CHAIN_DISPLAY[chain] ?? chain;
}
