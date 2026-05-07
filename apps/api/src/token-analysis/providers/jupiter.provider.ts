import { Injectable, Logger } from '@nestjs/common';
import { HttpError, http } from '../../common/http';

export interface JupiterTokenData {
  verified: boolean;
  organicScore: number | null;  // 0-100, null if not scored
  symbol?: string;
  name?: string;
  decimals?: number;
  logoUri?: string;
  tags?: string[];
}

export interface JupiterPriceImpact {
  buy500Usd?: number;
  buy1000Usd?: number;
  buy5000Usd?: number;
}

/**
 * Jupiter API — free, no auth required.
 * Provides: token verification status, organic score (anti-manipulation),
 * and swap quote for price-impact simulation.
 *
 * Docs: https://dev.jup.ag/docs/token-api / https://lite-api.jup.ag
 */
@Injectable()
export class JupiterProvider {
  private readonly logger = new Logger(JupiterProvider.name);
  private readonly base = (process.env.JUPITER_API_BASE ?? 'https://lite-api.jup.ag').replace(/\/swap\/v1$/, '');
  private readonly tokenBase = 'https://tokens.jup.ag';
  private readonly priceBase = 'https://api.jup.ag/price/v2';

  async getTokenData(mint: string): Promise<JupiterTokenData | null> {
    try {
      const data = await http.get<any>(`${this.tokenBase}/token/${mint}`, { timeoutMs: 6_000 });
      if (!data) return null;
      return {
        verified: data.tags?.includes('verified') ?? false,
        organicScore: typeof data.organicScore === 'number' ? Math.round(data.organicScore) : null,
        symbol: data.symbol,
        name: data.name,
        decimals: data.decimals,
        logoUri: data.logoURI,
        tags: Array.isArray(data.tags) ? data.tags : [],
      };
    } catch (e: any) {
      if (e instanceof HttpError && e.status === 404) return null;
      this.logger.debug(`Jupiter token data failed for ${mint}: ${e.message}`);
      return null;
    }
  }

  /**
   * Simulate buy price impact at $500, $1K, $5K using Jupiter quote API.
   * SOL price used to convert USD → SOL input amount.
   * Returns impact as percentage (e.g. 2.5 = 2.5% slippage).
   */
  async getPriceImpact(mint: string): Promise<JupiterPriceImpact | null> {
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

    try {
      // Get SOL price in USD via Jupiter price API
      const priceData = await http.get<any>(`${this.priceBase}`, {
        params: { ids: SOL_MINT },
        timeoutMs: 5_000,
      });
      const solPrice = priceData?.data?.[SOL_MINT]?.price;
      if (!solPrice || solPrice <= 0) return null;

      // Simulate buys of $500, $1000, $5000 using USDC → token route
      const sizes = [500, 1000, 5000];
      const quoteBase = `${this.base}/swap/v1/quote`;

      const results = await Promise.allSettled(
        sizes.map((usdAmt) =>
          http.get<any>(quoteBase, {
            params: {
              inputMint: USDC_MINT,
              outputMint: mint,
              amount: Math.round(usdAmt * 1_000_000), // USDC has 6 decimals
              slippageBps: 500,
              onlyDirectRoutes: false,
            },
            timeoutMs: 4_000,
          }),
        ),
      );

      const [r500, r1000, r5000] = results.map((r) => {
        if (r.status !== 'fulfilled' || !r.value) return undefined;
        const impact = r.value.priceImpactPct;
        return typeof impact === 'number' ? Math.abs(impact) * 100 : undefined;
      });

      return { buy500Usd: r500, buy1000Usd: r1000, buy5000Usd: r5000 };
    } catch (e: any) {
      this.logger.debug(`Jupiter price impact failed for ${mint}: ${e.message}`);
      return null;
    }
  }
}
