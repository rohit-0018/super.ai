import { Injectable } from '@nestjs/common';
import { http } from '../../common/http';

@Injectable()
export class CoinGeckoProvider {
  private base = 'https://api.coingecko.com/api/v3';
  private headers: Record<string, string> = process.env.COINGECKO_API_KEY
    ? { 'x-cg-pro-api-key': process.env.COINGECKO_API_KEY }
    : {};

  async price(ids: string[], vs = 'usd'): Promise<Record<string, { usd: number }>> {
    return http.get(`${this.base}/simple/price`, {
      headers: this.headers,
      timeoutMs: 8_000,
      params: { ids: ids.join(','), vs_currencies: vs },
    });
  }

  async trending(): Promise<unknown> {
    return http.get(`${this.base}/search/trending`, { headers: this.headers, timeoutMs: 8_000 });
  }

  async topMovers(limit = 25): Promise<unknown> {
    return http.get(`${this.base}/coins/markets`, {
      headers: this.headers,
      timeoutMs: 8_000,
      params: { vs_currency: 'usd', order: 'price_change_percentage_24h_desc', per_page: limit, page: 1 },
    });
  }
}
