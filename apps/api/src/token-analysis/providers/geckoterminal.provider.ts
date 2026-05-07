import { Injectable, Logger } from '@nestjs/common';
import type { Chain } from '../token-analysis.types';
import { parseRetryAfter } from '../../common/http';
import { ProviderPoolService } from '../../provider-pool/provider-pool.service';

/**
 * GeckoTerminal public API (CoinGecko-owned, no auth required).
 * Docs: https://www.geckoterminal.com/dex-api
 *
 * We use it as a SUPPLEMENT to DexScreener — it returns market_cap_usd,
 * fdv_usd, total_reserve_in_usd, holders count, and price-change windows
 * (1h/6h/24h/7d) directly from the canonical pool. Fills gaps where
 * DexScreener's chosen pair lacks fields.
 *
 * Network mapping:
 *   SOLANA  → "solana"
 *   EVM     → DexScreener chainId (ethereum/bsc/base/...) since GeckoTerminal
 *             uses similar slugs. We pass through whatever caller has.
 */
export interface GeckoTokenSupplement {
  symbol?: string;
  name?: string;
  priceUsd?: number;
  marketCapUsd?: number;
  fdvUsd?: number;
  totalReserveUsd?: number;
  holdersCount?: number;
  volume24hUsd?: number;
  priceChange?: { h1?: number; h6?: number; h24?: number };
}

@Injectable()
export class GeckoTerminalProvider {
  private readonly logger = new Logger(GeckoTerminalProvider.name);
  private readonly base = 'https://api.geckoterminal.com/api/v2';
  private readonly providerKey = 'geckoterminal';

  constructor(private readonly pool: ProviderPoolService) {}

  /** Map our chain (+ optional dex chain id) → GeckoTerminal network slug. */
  private network(chain: Chain, dexChainId?: string): string {
    if (chain === 'SOLANA') return 'solana';
    // GeckoTerminal slugs ≈ DexScreener slugs (eth/bsc/base/arbitrum/...)
    if (!dexChainId) return 'eth';
    const m: Record<string, string> = {
      ethereum: 'eth',
      bsc: 'bsc',
      polygon: 'polygon_pos',
      arbitrum: 'arbitrum',
      optimism: 'optimism',
      base: 'base',
      avalanche: 'avax',
    };
    return m[dexChainId] ?? dexChainId;
  }

  async getToken(
    chain: Chain,
    address: string,
    dexChainId?: string,
  ): Promise<GeckoTokenSupplement | null> {
    const network = this.network(chain, dexChainId);
    if (!(await this.pool.isAvailable(this.providerKey))) return null;
    try {
      const res = await fetch(`${this.base}/networks/${network}/tokens/${address}?include=top_pools`, {
        headers: { 'User-Agent': 'qwai/1.0', accept: 'application/json' },
        // Healthy GeckoTerminal responds in <500ms. 3s upper bound; beyond
        // that the request is effectively dead and not worth waiting on.
        signal: AbortSignal.timeout(3_000),
      });
      if (res.status === 429) {
        await this.pool.markRateLimited(this.providerKey, parseRetryAfter(res.headers));
        return null;
      }
      if (!res.ok) {
        this.logger.warn(`GeckoTerminal ${network} ${address}: ${res.status}`);
        return null;
      }
      const body = (await res.json()) as any;
      const attr = body?.data?.attributes;
      if (!attr) return null;

      const incl: any[] = Array.isArray(body?.included) ? body.included : [];
      const topPool = incl.find((x) => x.type === 'pool');
      const pa = topPool?.attributes ?? {};

      return {
        symbol: attr.symbol,
        name: attr.name,
        priceUsd: numOrU(attr.price_usd),
        marketCapUsd: numOrU(attr.market_cap_usd),
        fdvUsd: numOrU(attr.fdv_usd),
        totalReserveUsd: numOrU(attr.total_reserve_in_usd),
        holdersCount: numOrU(attr?.holders?.count) ?? numOrU(attr.holders),
        volume24hUsd: numOrU(pa?.volume_usd?.h24),
        priceChange: {
          h1:  numOrU(pa?.price_change_percentage?.h1),
          h6:  numOrU(pa?.price_change_percentage?.h6),
          h24: numOrU(pa?.price_change_percentage?.h24),
        },
      };
    } catch (e: any) {
      this.logger.warn(`GeckoTerminal failed: ${e?.message}`);
      return null;
    }
  }
}

function numOrU(v: any): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
