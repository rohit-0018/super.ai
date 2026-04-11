import { Injectable } from '@nestjs/common';
import axios from 'axios';

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
    const r = await axios.get(`${this.base}/quote`, {
      params: { inputMint, outputMint, amount, slippageBps, onlyDirectRoutes: false },
      timeout: 8_000,
    });
    return r.data;
  }

  async swapTx(quote: JupQuote, userPublicKey: string, useJito = true) {
    const r = await axios.post(`${this.base}/swap`, {
      quoteResponse: quote,
      userPublicKey,
      wrapAndUnwrapSol: true,
      prioritizationFeeLamports: 'auto',
      asLegacyTransaction: false,
      computeUnitPriceMicroLamports: useJito ? undefined : 'auto',
    });
    return r.data; // { swapTransaction: base64 }
  }
}
