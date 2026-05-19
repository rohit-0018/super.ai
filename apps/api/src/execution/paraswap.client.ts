import { Injectable, Logger } from '@nestjs/common';
import { http } from '../common/http';
import { CircuitBreaker } from '../common/circuit-breaker';

const breaker = new CircuitBreaker('Paraswap', 5, 30_000);

const PARASWAP_API_BASE =
  process.env.PARASWAP_API_BASE ?? 'https://apiv5.paraswap.io';

export interface ParaswapQuote {
  srcToken: string;
  destToken: string;
  srcAmount: string;
  destAmount: string;
  priceRoute: unknown;
}

@Injectable()
export class ParaswapClient {
  private readonly logger = new Logger(ParaswapClient.name);

  async quote(
    chainId: number,
    srcToken: string,
    destToken: string,
    srcAmount: string,
  ): Promise<ParaswapQuote> {
    const raw = await breaker.exec(() =>
      http.get<any>(`${PARASWAP_API_BASE}/prices`, {
        timeoutMs: 8_000,
        params: {
          srcToken,
          destToken,
          amount: srcAmount,
          network: chainId,
          side: 'SELL',
          includeDEXS: 'UniswapV3,SushiSwap,Curve',
        },
      }),
    );
    const route = raw?.priceRoute;
    if (!route) throw new Error('Paraswap: no priceRoute in response');
    return {
      srcToken,
      destToken,
      srcAmount,
      destAmount: route.destAmount ?? '0',
      priceRoute: route,
    };
  }

  async buildTx(
    chainId: number,
    quote: ParaswapQuote,
    userAddress: string,
    slippageBps: number,
  ): Promise<{ to: string; data: string; value: string; gas: string; gasPrice: string }> {
    const slippagePct = (slippageBps / 100).toFixed(2);
    const raw = await breaker.exec(() =>
      http.post<any>(`${PARASWAP_API_BASE}/transactions/${chainId}`, {
        srcToken: quote.srcToken,
        destToken: quote.destToken,
        srcAmount: quote.srcAmount,
        destAmount: quote.destAmount,
        slippage: slippagePct,
        priceRoute: quote.priceRoute,
        userAddress,
      }),
    );
    if (!raw?.to) throw new Error('Paraswap: no tx in response');
    return {
      to: raw.to,
      data: raw.data,
      value: raw.value ?? '0',
      gas: raw.gas ?? '300000',
      gasPrice: raw.gasPrice ?? '0',
    };
  }
}
