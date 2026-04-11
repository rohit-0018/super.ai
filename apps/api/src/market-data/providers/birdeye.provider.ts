import { Injectable } from '@nestjs/common';
import { http } from '../../common/http';

@Injectable()
export class BirdeyeProvider {
  private base = 'https://public-api.birdeye.so';
  private headers = { 'X-API-KEY': process.env.BIRDEYE_API_KEY ?? '' };

  async tokenOverview(address: string) {
    const r: any = await http.get(`${this.base}/defi/token_overview`, {
      headers: this.headers,
      timeoutMs: 8_000,
      params: { address },
    });
    return r?.data ?? null;
  }

  async priceSolana(address: string): Promise<number | null> {
    try {
      const r: any = await http.get(`${this.base}/defi/price`, {
        headers: this.headers,
        timeoutMs: 8_000,
        params: { address },
      });
      return r?.data?.value ?? null;
    } catch {
      return null;
    }
  }
}
