import { Injectable, Logger } from '@nestjs/common';
import { HttpError, http } from '../../common/http';

export interface EtherscanHolders {
  top10ConcentrationPct: number | null;
  topHolders: Array<{ address: string; pct: number }>;
}

const CHAIN_BASE: Record<string, string> = {
  ethereum: 'https://api.etherscan.io',
  bsc:      'https://api.bscscan.com',
  base:     'https://api.basescan.org',
  arbitrum: 'https://api.arbiscan.io',
  optimism: 'https://api-optimistic.etherscan.io',
  polygon:  'https://api.polygonscan.com',
  avalanche:'https://api.snowtrace.io',
};

/**
 * Etherscan-family APIs — free tier (5 req/sec, API key required).
 * Gets top token holders for EVM chains.
 *
 * Get key: https://etherscan.io/myapikey (free registration)
 * Same key works for Etherscan, Basescan (different site, free key there too).
 */
@Injectable()
export class EtherscanProvider {
  private readonly logger = new Logger(EtherscanProvider.name);
  private readonly apiKey: string | null;

  constructor() {
    this.apiKey = process.env.ETHERSCAN_API_KEY ?? null;
    if (!this.apiKey) {
      this.logger.warn('ETHERSCAN_API_KEY not set — Etherscan disabled');
    }
  }

  get isAvailable(): boolean { return !!this.apiKey; }

  async getTopHolders(chainId: string, address: string): Promise<EtherscanHolders | null> {
    if (!this.apiKey) return null;
    const base = CHAIN_BASE[chainId];
    if (!base) return null;

    try {
      const data = await http.get<any>(`${base}/api`, {
        params: {
          module: 'token',
          action: 'tokenholderlist',
          contractaddress: address,
          page: '1',
          offset: '20',
          apikey: this.apiKey,
        },
        timeoutMs: 10_000,
      });
      const result: any[] = Array.isArray(data?.result) ? data.result : [];
      if (!result.length) return null;

      // Etherscan returns TokenHolderQuantity (raw), we compute supply % from sum
      const quantities = result.map((h) => BigInt(h.TokenHolderQuantity ?? '0'));
      const totalFromTop = quantities.reduce((s, q) => s + q, BigInt(0));
      if (totalFromTop === BigInt(0)) return null;

      const topHolders = result.slice(0, 10).map((h, i) => ({
        address: h.TokenHolderAddress ?? '',
        pct: Number((quantities[i] * BigInt(10000)) / totalFromTop) / 100,
      }));
      const top10Pct = topHolders.reduce((s, h) => s + h.pct, 0);

      return { top10ConcentrationPct: Math.min(100, top10Pct), topHolders };
    } catch (e: any) {
      if (e instanceof HttpError && e.status === 429) throw e;
      this.logger.warn(`Etherscan holders failed for ${address}: ${e.message}`);
      return null;
    }
  }
}
