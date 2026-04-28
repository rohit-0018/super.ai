import { Injectable } from '@nestjs/common';
import { CoinGeckoProvider, CgCoinMarket } from './providers/coingecko.provider';
import { BirdeyeProvider } from './providers/birdeye.provider';

export interface TrendingToken {
  id: string;
  symbol: string;
  name: string;
  priceUsd: number | null;
  change24h: number | null;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  rank: number | null;
  image: string | null;
}

// Default watchlist — always included in trending-prices response
const DEFAULT_IDS = [
  'bitcoin',
  'ethereum',
  'solana',
  'jupiter-exchange-solana',
  'dogwifcoin',
  'bonk',
];

@Injectable()
export class MarketDataService {
  constructor(private cg: CoinGeckoProvider, private be: BirdeyeProvider) {}

  trending() { return this.cg.trending(); }
  topMovers() { return this.cg.topMovers(); }

  async price(symbolOrAddress: string): Promise<number | null> {
    if (symbolOrAddress.length > 30) return this.be.priceSolana(symbolOrAddress);
    const m = await this.cg.price([symbolOrAddress.toLowerCase()]);
    return m[symbolOrAddress.toLowerCase()]?.usd ?? null;
  }

  /** Single CoinGecko call for multiple IDs — returns { [id]: priceUsd } */
  async prices(ids: string[]): Promise<Record<string, number | null>> {
    const m = await this.cg.price(ids.map((id) => id.toLowerCase()));
    return Object.fromEntries(ids.map((id) => [id, m[id.toLowerCase()]?.usd ?? null]));
  }

  /**
   * Returns top 10 trending tokens from CoinGecko plus the DEFAULT_IDS watchlist.
   * Uses /coins/markets for rich data (price, change, volume, rank) in one call.
   */
  async trendingWithPrices(extraIds: string[] = []): Promise<TrendingToken[]> {
    // Pull trending coins list (7-day search trending on CoinGecko)
    let trendingIds: string[] = [];
    try {
      const raw = await this.cg.trending() as any;
      trendingIds = (raw?.coins ?? [])
        .slice(0, 10)
        .map((c: any) => c?.item?.id)
        .filter(Boolean);
    } catch {
      // trending call failed — continue with defaults
    }

    // Merge: trending + defaults + caller-supplied extras, deduplicated, max 20
    const allIds = [...new Set([...trendingIds, ...DEFAULT_IDS, ...extraIds])].slice(0, 20);

    const markets = await this.cg.markets(allIds);

    // Build a map for quick lookup
    const byId = new Map<string, CgCoinMarket>(markets.map((m) => [m.id, m]));

    // Return in order: trending first, then defaults, unique
    return allIds
      .filter((id) => byId.has(id))
      .map((id) => {
        const m = byId.get(id)!;
        return {
          id: m.id,
          symbol: m.symbol?.toUpperCase() ?? id,
          name: m.name,
          priceUsd: m.current_price,
          change24h: m.price_change_percentage_24h,
          marketCapUsd: m.market_cap,
          volume24hUsd: m.total_volume,
          rank: m.market_cap_rank,
          image: m.image,
        };
      });
  }
}
