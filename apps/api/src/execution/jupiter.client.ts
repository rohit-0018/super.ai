import { Injectable } from '@nestjs/common';
import { http } from '../common/http';

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
  private base = process.env.JUPITER_API_BASE ?? 'https://quote-api.jup.ag/v6';

  async quote(inputMint: string, outputMint: string, amount: string, slippageBps: number): Promise<JupQuote> {
    return http.get<JupQuote>(`${this.base}/quote`, {
      timeoutMs: 8_000,
      params: { inputMint, outputMint, amount, slippageBps, onlyDirectRoutes: false },
    });
  }

  async swapTx(quote: JupQuote, userPublicKey: string, useJito = true) {
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
