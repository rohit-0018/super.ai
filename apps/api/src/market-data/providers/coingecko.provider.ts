import { Injectable } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';

@Injectable()
export class CoinGeckoProvider {
  private http: AxiosInstance = axios.create({
    baseURL: 'https://api.coingecko.com/api/v3',
    timeout: 8_000,
    headers: process.env.COINGECKO_API_KEY ? { 'x-cg-pro-api-key': process.env.COINGECKO_API_KEY } : {},
  });

  async price(ids: string[], vs = 'usd'): Promise<Record<string, { usd: number }>> {
    const r = await this.http.get('/simple/price', { params: { ids: ids.join(','), vs_currencies: vs } });
    return r.data;
  }

  async trending(): Promise<unknown> {
    const r = await this.http.get('/search/trending');
    return r.data;
  }

  async topMovers(limit = 25): Promise<unknown> {
    const r = await this.http.get('/coins/markets', {
      params: { vs_currency: 'usd', order: 'price_change_percentage_24h_desc', per_page: limit, page: 1 },
    });
    return r.data;
  }
}
