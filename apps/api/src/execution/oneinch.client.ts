import { Injectable } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class OneInchClient {
  private base(chainId: number) { return `https://api.1inch.dev/swap/v6.0/${chainId}`; }
  private headers() {
    return { Authorization: `Bearer ${process.env.ONEINCH_API_KEY ?? ''}` };
  }

  async quote(chainId: number, src: string, dst: string, amount: string) {
    const r = await axios.get(`${this.base(chainId)}/quote`, {
      params: { src, dst, amount },
      headers: this.headers(),
      timeout: 8_000,
    });
    return r.data;
  }

  async swap(chainId: number, src: string, dst: string, amount: string, from: string, slippage: number) {
    const r = await axios.get(`${this.base(chainId)}/swap`, {
      params: { src, dst, amount, from, slippage, disableEstimate: false },
      headers: this.headers(),
      timeout: 8_000,
    });
    return r.data;
  }
}
