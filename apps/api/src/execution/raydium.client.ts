import { Injectable, Logger } from '@nestjs/common';
import { http } from '../common/http';
import { CircuitBreaker } from '../common/circuit-breaker';

const breaker = new CircuitBreaker('Raydium', 5, 30_000);

const RAYDIUM_API_BASE =
  process.env.RAYDIUM_API_BASE ?? 'https://transaction-v1.raydium.io';

export interface RaydiumQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
}

@Injectable()
export class RaydiumClient {
  private readonly logger = new Logger(RaydiumClient.name);

  async quote(
    inputMint: string,
    outputMint: string,
    amount: string,
    slippageBps: number,
  ): Promise<RaydiumQuote> {
    const raw = await breaker.exec(() =>
      http.get<any>(`${RAYDIUM_API_BASE}/compute/swap-base-in`, {
        timeoutMs: 8_000,
        params: { inputMint, outputMint, amount, slippageBps, txVersion: 'V0' },
      }),
    );
    // Raydium wraps response in { success, data }
    const data = raw?.data ?? raw;
    return {
      inputMint,
      outputMint,
      inAmount: amount,
      outAmount: data?.outputAmount ?? data?.outAmount ?? '0',
      priceImpactPct: data?.priceImpactPct ?? '0',
    };
  }

  async swapTx(quote: RaydiumQuote, userPublicKey: string, slippageBps: number): Promise<string> {
    const raw = await breaker.exec(() =>
      http.post<any>(`${RAYDIUM_API_BASE}/transaction/swap-base-in`, {
        computeUnitPriceMicroLamports: 'auto',
        swapResponse: {
          id: '',
          success: true,
          data: { swapType: 'BaseIn', inputMint: quote.inputMint, inputAmount: quote.inAmount, outputMint: quote.outputMint, outputAmount: quote.outAmount, otherAmountThreshold: '0', slippageBps, priceImpactPct: quote.priceImpactPct, referencePrice: null },
        },
        txVersion: 'V0',
        wallet: userPublicKey,
        wrapSol: true,
        unwrapSol: true,
      }),
    );
    // Raydium returns { data: [{ transaction: base64 }] }
    const tx = raw?.data?.[0]?.transaction ?? raw?.transaction;
    if (!tx) throw new Error('Raydium: no transaction in response');
    return tx as string;
  }
}
