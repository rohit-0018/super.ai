import { Injectable, Logger } from '@nestjs/common';
import type { BundleInfo } from '../token-analysis.types';

/**
 * Bitquery GraphQL API — free 10K points/month.
 * Used as FALLBACK for bundle detection when BundleChecker is unavailable.
 * Each query costs ~30 points, so use sparingly (~333 calls/month on free tier).
 *
 * Get key: https://bitquery.io (free signup)
 * Docs: https://docs.bitquery.io
 */
@Injectable()
export class BitqueryProvider {
  private readonly logger = new Logger(BitqueryProvider.name);
  private readonly endpoint = 'https://streaming.bitquery.io/graphql';
  private readonly apiKey: string | null;

  constructor() {
    this.apiKey = process.env.BITQUERY_API_KEY ?? null;
    if (!this.apiKey) {
      this.logger.warn('BITQUERY_API_KEY not set — Bitquery disabled');
    }
  }

  get isAvailable(): boolean { return !!this.apiKey; }

  /** Detect bundled launch buys via Jito bundle data on Solana. */
  async getSolanaBundle(mint: string): Promise<BundleInfo | null> {
    if (!this.apiKey) return null;

    const query = `{
      Solana {
        DEXTrades(
          where: {
            Trade: { Buy: { Currency: { MintAddress: { is: "${mint}" } } } }
            Transaction: { Result: { Success: true } }
            Block: { Time: { after: "${sevenDaysAgo()}" } }
          }
          limit: { count: 200 }
          orderBy: { ascending: Block_Time }
        ) {
          Transaction { Signature Signer }
          Trade { Buy { Amount Currency { Symbol } } Buy { Price } }
          Block { Time }
        }
      }
    }`;

    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        if (res.status === 429) {
          const err = new Error('Bitquery rate limit') as any;
          err.status = 429;
          throw err;
        }
        return null;
      }
      const body = await res.json();
      const trades: any[] = body?.data?.Solana?.DEXTrades ?? [];
      if (!trades.length) return { detected: false, source: 'bitquery' };

      // Cluster signers that appear in the same block (possible bundle pattern)
      const blockGroups = new Map<string, Set<string>>();
      for (const t of trades) {
        const blockTime = t.Block?.Time;
        const signer = t.Transaction?.Signer;
        if (!blockTime || !signer) continue;
        if (!blockGroups.has(blockTime)) blockGroups.set(blockTime, new Set());
        blockGroups.get(blockTime)!.add(signer);
      }

      // A "bundle" = same block, multiple different wallets buying
      const bundleBlocks = [...blockGroups.entries()].filter(([, wallets]) => wallets.size >= 2);
      if (!bundleBlocks.length) return { detected: false, source: 'bitquery' };

      const allBundledWallets = new Set<string>();
      for (const [, wallets] of bundleBlocks) {
        for (const w of wallets) allBundledWallets.add(w);
      }

      return {
        detected: true,
        bundleCount: bundleBlocks.length,
        bundledWallets: [...allBundledWallets].slice(0, 10),
        source: 'bitquery',
      };
    } catch (e: any) {
      if (e?.status === 429) throw e;
      this.logger.warn(`Bitquery bundle query failed for ${mint}: ${e.message}`);
      return null;
    }
  }
}

function sevenDaysAgo(): string {
  return new Date(Date.now() - 7 * 86400 * 1000).toISOString();
}
