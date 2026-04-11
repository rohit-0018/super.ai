import { Injectable } from '@nestjs/common';
import { http } from '../common/http';

@Injectable()
export class OneInchClient {
  private base(chainId: number) {
    return `https://api.1inch.dev/swap/v6.0/${chainId}`;
  }
  private headers() {
    return { Authorization: `Bearer ${process.env.ONEINCH_API_KEY ?? ''}` };
  }

  async quote(chainId: number, src: string, dst: string, amount: string) {
    return http.get(`${this.base(chainId)}/quote`, {
      headers: this.headers(),
      timeoutMs: 8_000,
      params: { src, dst, amount },
    });
  }

  async swap(chainId: number, src: string, dst: string, amount: string, from: string, slippage: number) {
    return http.get(`${this.base(chainId)}/swap`, {
      headers: this.headers(),
      timeoutMs: 8_000,
      params: { src, dst, amount, from, slippage, disableEstimate: false },
    });
  }
}
