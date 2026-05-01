import { Injectable, Logger } from '@nestjs/common';
import type { Chain, TokenMeta } from '../token-analysis.types';

/**
 * DexScreener free API — https://docs.dexscreener.com/api/reference
 * Tokens endpoint: GET https://api.dexscreener.com/latest/dex/tokens/{address}
 * Returns all pairs for that token across DEXs/chains. We pick the highest-liquidity pair.
 * No auth required. Rate-limit 300/min per IP (soft).
 */
@Injectable()
export class DexScreenerProvider {
  private readonly logger = new Logger(DexScreenerProvider.name);
  private readonly base = 'https://api.dexscreener.com/latest/dex';

  async getToken(chain: Chain, address: string): Promise<TokenMeta | null> {
    try {
      const res = await fetch(`${this.base}/tokens/${address}`, {
        headers: { 'User-Agent': 'qwai/1.0' },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) {
        this.logger.warn(`DexScreener non-200 for ${address}: ${res.status}`);
        return null;
      }
      const body = await res.json() as any;
      const pairs: any[] = Array.isArray(body?.pairs) ? body.pairs : [];
      if (!pairs.length) return null;

      // Filter to correct chain
      const EVM_CHAINS = new Set([
        'ethereum', 'bsc', 'base', 'arbitrum', 'optimism', 'polygon',
        'avalanche', 'zksync', 'linea', 'blast', 'scroll', 'mantle',
        'fantom', 'cronos', 'gnosis', 'celo', 'moonbeam', 'aurora',
      ]);
      const onChain = pairs.filter((p) =>
        chain === 'SOLANA' ? p.chainId === 'solana' : EVM_CHAINS.has(p.chainId),
      );
      if (!onChain.length) return null;

      // Pick the highest-liquidity pair
      const top = onChain.sort(
        (a, b) => (b?.liquidity?.usd ?? 0) - (a?.liquidity?.usd ?? 0),
      )[0];
      if (!top) return null;

      const isBase = top.baseToken?.address?.toLowerCase() === address.toLowerCase();
      const token = isBase ? top.baseToken : top.quoteToken;

      const pairCreatedAt = top.pairCreatedAt ? new Date(top.pairCreatedAt).toISOString() : undefined;
      const pairAgeHours = top.pairCreatedAt
        ? Math.max(0, (Date.now() - top.pairCreatedAt) / 3_600_000)
        : undefined;

      return {
        chain,
        chainId: top.chainId,
        address,
        symbol: token?.symbol,
        name: token?.name,
        priceUsd: numOrUndef(top.priceUsd),
        marketCapUsd: numOrUndef(top.marketCap),
        fdvUsd: numOrUndef(top.fdv),
        liquidityUsd: numOrUndef(top?.liquidity?.usd),
        volume24hUsd: numOrUndef(top?.volume?.h24),
        priceChange: {
          m5: numOrUndef(top?.priceChange?.m5),
          h1: numOrUndef(top?.priceChange?.h1),
          h6: numOrUndef(top?.priceChange?.h6),
          h24: numOrUndef(top?.priceChange?.h24),
        },
        txns24h: {
          buys: top?.txns?.h24?.buys,
          sells: top?.txns?.h24?.sells,
        },
        pairCreatedAt,
        pairAgeHours,
        dex: top.dexId,
        url: top.url,
        socials:  Array.isArray(top?.info?.socials)  ? top.info.socials  : [],
        websites: Array.isArray(top?.info?.websites) ? top.info.websites : [],
      };
    } catch (e: any) {
      this.logger.warn(`DexScreener fetch failed: ${e?.message}`);
      return null;
    }
  }
}

function numOrUndef(v: any): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
