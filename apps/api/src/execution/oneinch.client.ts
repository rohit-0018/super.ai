import { Injectable } from '@nestjs/common';
import { http } from '../common/http';
import { CircuitBreaker } from '../common/circuit-breaker';

const breaker = new CircuitBreaker('1inch', 5, 30_000);

@Injectable()
export class OneInchClient {
  private base(chainId: number) {
    return `https://api.1inch.dev/swap/v6.0/${chainId}`;
  }
  private headers() {
    return { Authorization: `Bearer ${process.env.ONEINCH_API_KEY ?? ''}` };
  }

  async quote(chainId: number, src: string, dst: string, amount: string) {
    return breaker.exec(() =>
      http.get(`${this.base(chainId)}/quote`, {
        headers: this.headers(),
        timeoutMs: 8_000,
        params: { src, dst, amount },
      }),
    );
  }

  async swap(chainId: number, src: string, dst: string, amount: string, from: string, slippage: number) {
    return http.get(`${this.base(chainId)}/swap`, {
      headers: this.headers(),
      timeoutMs: 8_000,
      params: { src, dst, amount, from, slippage, disableEstimate: false },
    });
  }
}
