import { Injectable, Logger } from '@nestjs/common';
import { HttpError, http } from '../../common/http';
import type { LifecycleInfo } from '../token-analysis.types';

/**
 * Moralis API — free tier (25 req/sec, registration required).
 * Speciality: pump.fun bonding curve progress, graduation status,
 * and EVM token holder data.
 *
 * Get key: https://moralis.io (free signup)
 * Docs: https://docs.moralis.io
 */
@Injectable()
export class MoralisProvider {
  private readonly logger = new Logger(MoralisProvider.name);
  private readonly base = 'https://deep-index.moralis.io/api/v2.2';
  private readonly apiKey: string | null;

  constructor() {
    this.apiKey = process.env.MORALIS_API_KEY ?? null;
    if (!this.apiKey) {
      this.logger.warn('MORALIS_API_KEY not set — Moralis disabled');
    }
  }

  get isAvailable(): boolean { return !!this.apiKey; }

  private get headers(): Record<string, string> {
    return { 'X-API-Key': this.apiKey!, accept: 'application/json' };
  }

  /** pump.fun lifecycle for a Solana token. */
  async getPumpLifecycle(mint: string): Promise<LifecycleInfo | null> {
    if (!this.apiKey) return null;
    try {
      const data = await http.get<any>(
        `${this.base}/solana/tokens/${mint}/pairs`,
        { headers: this.headers, timeoutMs: 4_000 },
      );
      const pairs: any[] = Array.isArray(data?.result) ? data.result : [];
      const pumpPair = pairs.find((p) => /pump/i.test(p?.exchangeName ?? ''));

      if (!pumpPair) {
        // Token may be on raydium directly (no pump.fun history)
        if (pairs.length > 0) return { stage: 'mature', launchPlatform: 'raydium' };
        return null;
      }

      const bondingCurvePct = pumpPair.bondingCurveProgress != null
        ? Number(pumpPair.bondingCurveProgress) : undefined;
      const graduated = pumpPair.pairLabel === 'GRADUATED' ||
        (bondingCurvePct != null && bondingCurvePct >= 100);

      return {
        stage: graduated ? 'graduated' : bondingCurvePct != null ? 'bonding' : 'unknown',
        bondingCurvePct,
        launchPlatform: graduated ? 'pumpswap' : 'pump.fun',
        graduatedAt: pumpPair.graduatedAt ?? undefined,
        kingOfTheHill: pumpPair.isKingOfTheHill ?? false,
      };
    } catch (e: any) {
      if (e instanceof HttpError && e.status === 404) return null;
      this.logger.warn(`Moralis pump lifecycle failed for ${mint}: ${e.message}`);
      return null;
    }
  }

  /** EVM token holder list (top-20). */
  async getEvmHolders(
    chain: string,
    address: string,
  ): Promise<{ top10Pct: number | null; totalHolders: number | null } | null> {
    if (!this.apiKey) return null;
    try {
      const moralisChain = EVM_CHAIN_MAP[chain] ?? chain;
      const data = await http.get<any>(
        `${this.base}/erc20/${address}/owners`,
        {
          headers: this.headers,
          params: { chain: moralisChain, limit: '100' },
          timeoutMs: 5_000,
        },
      );
      const result: any[] = Array.isArray(data?.result) ? data.result : [];
      if (!result.length) return null;

      const top10Pct = result.slice(0, 10).reduce((s, h) => {
        const pct = parseFloat(h.percentage_relative_to_total_supply ?? '0');
        return s + (isNaN(pct) ? 0 : pct);
      }, 0);

      return {
        top10Pct: Math.min(100, top10Pct),
        totalHolders: typeof data.total === 'number' ? data.total : null,
      };
    } catch (e: any) {
      if (e instanceof HttpError && e.status === 404) return null;
      this.logger.warn(`Moralis EVM holders failed for ${address}: ${e.message}`);
      return null;
    }
  }
}

const EVM_CHAIN_MAP: Record<string, string> = {
  ethereum: '0x1',
  bsc:      '0x38',
  polygon:  '0x89',
  base:     '0x2105',
  arbitrum: '0xa4b1',
  optimism: '0xa',
};
