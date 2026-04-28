import { Controller, Get, Param, Query } from '@nestjs/common';
import { MarketDataService } from './market-data.service';
import { TokenMetadataService } from './token-metadata.service';

@Controller('market')
export class MarketDataController {
  constructor(
    private svc: MarketDataService,
    private tokens: TokenMetadataService,
  ) {}

  /** Lazy-loaded token detail used by portfolio rows. Cached server-side (60s). */
  @Get('tokens/:mint') tokenDetail(@Param('mint') mint: string) {
    return this.tokens.get(mint);
  }

  @Get('trending') trending() { return this.svc.trending(); }
  @Get('top-movers') movers() { return this.svc.topMovers(); }
  @Get('price/:id') price(@Param('id') id: string) { return this.svc.price(id).then((p) => ({ id, priceUsd: p })); }

  /** Batch price fetch — one CoinGecko call for all ids. ?ids=solana,bitcoin,ethereum */
  @Get('prices')
  async prices(@Query('ids') ids: string) {
    const list = (ids ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (list.length === 0) return {};
    return this.svc.prices(list);
  }

  /**
   * Top 10 trending tokens (CoinGecko trending search) + default watchlist,
   * enriched with price / 24h change / market cap / volume.
   * Optional ?ids=extra-id-1,extra-id-2 to pin additional coins.
   */
  @Get('trending-prices')
  async trendingPrices(@Query('ids') ids?: string) {
    const extra = (ids ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return this.svc.trendingWithPrices(extra);
  }
}
