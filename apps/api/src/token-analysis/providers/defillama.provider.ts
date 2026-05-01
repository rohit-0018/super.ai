import { Injectable, Logger } from '@nestjs/common';
import { http } from '../../common/http';
import type { ChainContext } from '../token-analysis.types';

const CHAIN_SLUG: Record<string, string> = {
  solana:   'Solana',
  ethereum: 'Ethereum',
  bsc:      'BSC',
  base:     'Base',
  arbitrum: 'Arbitrum',
  optimism: 'Optimism',
  polygon:  'Polygon',
  avalanche:'Avalanche',
};

// In-memory TVL cache — chain data doesn't change by the minute
const tvlCache = new Map<string, { ctx: ChainContext; ts: number }>();
const TVL_CACHE_MS = 10 * 60 * 1000; // 10 min

/**
 * DeFiLlama API — completely free, no auth, no rate limits stated.
 * Provides: per-chain TVL (current + 7-day + 30-day change).
 *
 * Docs: https://defillama.com/docs/api
 */
@Injectable()
export class DeFiLlamaProvider {
  private readonly logger = new Logger(DeFiLlamaProvider.name);
  private readonly base = 'https://api.llama.fi';

  async getChainContext(chainId: string): Promise<ChainContext | null> {
    const slug = CHAIN_SLUG[chainId];
    if (!slug) return null;

    const cached = tvlCache.get(slug);
    if (cached && Date.now() - cached.ts < TVL_CACHE_MS) return cached.ctx;

    try {
      const data = await http.get<any[]>(`${this.base}/v2/historicalChainTvl/${slug}`, {
        timeoutMs: 8_000,
      });
      if (!Array.isArray(data) || data.length < 2) return null;

      const sorted = [...data].sort((a, b) => b.date - a.date);
      const current = sorted[0]?.tvl;
      const weekAgo = sorted.find((d) => d.date <= sorted[0].date - 7 * 86400)?.tvl;
      const monthAgo = sorted.find((d) => d.date <= sorted[0].date - 30 * 86400)?.tvl;

      const ctx: ChainContext = {
        tvlUsd: current,
        tvl7dChangePct: weekAgo && current ? ((current - weekAgo) / weekAgo) * 100 : undefined,
        tvl30dChangePct: monthAgo && current ? ((current - monthAgo) / monthAgo) * 100 : undefined,
      };
      tvlCache.set(slug, { ctx, ts: Date.now() });
      return ctx;
    } catch (e: any) {
      this.logger.warn(`DeFiLlama TVL failed for ${slug}: ${e.message}`);
      return null;
    }
  }
}
