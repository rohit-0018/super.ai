import { Injectable } from '@nestjs/common';
import { CoinGeckoProvider } from './providers/coingecko.provider';
import { BirdeyeProvider } from './providers/birdeye.provider';

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
}
