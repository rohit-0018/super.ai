import { Injectable, Logger } from '@nestjs/common';
import { http } from '../common/http';
import { CircuitBreaker } from '../common/circuit-breaker';
import { getJupiterApiBase, isTestnet } from '../common/network-config';

const breaker = new CircuitBreaker('Jupiter', 5, 30_000);

export interface JupQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  routePlan: unknown;
}

@Injectable()
export class JupiterClient {
  private readonly logger = new Logger(JupiterClient.name);
  private base = getJupiterApiBase();

  async quote(inputMint: string, outputMint: string, amount: string, slippageBps: number): Promise<JupQuote> {
    if (this.base === 'MOCK') {
      this.logger.debug(`[testnet] Mock Jupiter quote: ${inputMint} → ${outputMint}, amount=${amount}`);
      return {
        inputMint,
        outputMint,
        inAmount: amount,
        outAmount: amount, // 1:1 mock ratio
        priceImpactPct: '0.01',
        routePlan: [{ label: 'testnet-mock' }],
      };
    }
    return breaker.exec(() =>
      http.get<JupQuote>(`${this.base}/quote`, {
        timeoutMs: 8_000,
        params: { inputMint, outputMint, amount, slippageBps, onlyDirectRoutes: false },
      }),
    );
  }

  async swapTx(quote: JupQuote, userPublicKey: string, useJito = true) {
    if (this.base === 'MOCK') {
      this.logger.debug(`[testnet] Mock Jupiter swap — returning devnet SOL transfer`);
      return { swapTransaction: null, testnetMock: true };
    }
    return http.post(`${this.base}/swap`, {
      quoteResponse: quote,
      userPublicKey,
      wrapAndUnwrapSol: true,
      prioritizationFeeLamports: 'auto',
      asLegacyTransaction: false,
      computeUnitPriceMicroLamports: useJito ? undefined : 'auto',
    });
  }
}
