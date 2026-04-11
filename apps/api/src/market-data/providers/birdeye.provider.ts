import { Injectable } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';

@Injectable()
export class BirdeyeProvider {
  private http: AxiosInstance = axios.create({
    baseURL: 'https://public-api.birdeye.so',
    timeout: 8_000,
    headers: { 'X-API-KEY': process.env.BIRDEYE_API_KEY ?? '' },
  });

  async tokenOverview(address: string) {
    const r = await this.http.get('/defi/token_overview', { params: { address } });
    return r.data?.data ?? null;
  }

  async priceSolana(address: string): Promise<number | null> {
    try {
      const r = await this.http.get('/defi/price', { params: { address } });
      return r.data?.data?.value ?? null;
    } catch { return null; }
  }
}
