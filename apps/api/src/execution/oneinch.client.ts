import { Injectable, Logger } from '@nestjs/common';
import { http } from '../common/http';
import { CircuitBreaker } from '../common/circuit-breaker';
import { isTestnet } from '../common/network-config';

const breaker = new CircuitBreaker('1inch', 5, 30_000);

@Injectable()
export class OneInchClient {
  private readonly logger = new Logger(OneInchClient.name);
  private readonly testnet = isTestnet();

  private base(chainId: number) {
    return `https://api.1inch.dev/swap/v6.0/${chainId}`;
  }
  private headers() {
    return { Authorization: `Bearer ${process.env.ONEINCH_API_KEY ?? ''}` };
  }

  async quote(chainId: number, src: string, dst: string, amount: string) {
    if (this.testnet) {
      this.logger.debug(`[testnet] Mock 1inch quote: ${src} → ${dst}, amount=${amount}`);
      return { dstAmount: amount, srcToken: src, dstToken: dst, protocols: [['testnet-mock']] };
    }
    return breaker.exec(() =>
      http.get(`${this.base(chainId)}/quote`, {
        headers: this.headers(),
        timeoutMs: 8_000,
        params: { src, dst, amount },
      }),
    );
  }

  async swap(chainId: number, src: string, dst: string, amount: string, from: string, slippage: number) {
    if (this.testnet) {
      this.logger.debug(`[testnet] Mock 1inch swap — returning direct testnet transfer`);
      return {
        dstAmount: amount,
        tx: { to: dst, data: '0x', value: '0', gas: '21000', gasPrice: '1000000000' },
        testnetMock: true,
      };
    }
    return http.get(`${this.base(chainId)}/swap`, {
      headers: this.headers(),
      timeoutMs: 8_000,
      params: { src, dst, amount, from, slippage, disableEstimate: false },
    });
  }
}
