import { Injectable, Logger } from '@nestjs/common';
import type { HolderMetrics } from '../token-analysis.types';

/**
 * Fetches Solana token holder metrics via Helius RPC.
 * Uses standard JSON-RPC methods — no Helius-specific extensions needed.
 * Gracefully returns null when HELIUS_RPC_URL is not configured.
 */
@Injectable()
export class HeliusHoldersProvider {
  private readonly logger = new Logger(HeliusHoldersProvider.name);
  private readonly rpcUrl: string | null;

  constructor() {
    this.rpcUrl = process.env.HELIUS_RPC_URL ?? null;
    if (!this.rpcUrl) {
      this.logger.warn('HELIUS_RPC_URL not set — holder metrics will be unavailable');
    }
  }

  async getHolderMetrics(
    mint: string,
    rugcheckRisks?: Array<{ name?: string; level?: string }>,
  ): Promise<HolderMetrics | null> {
    if (!this.rpcUrl) return null;

    try {
      const [largestResult, supplyResult] = await Promise.allSettled([
        this.rpcCall('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }]),
        this.rpcCall('getTokenSupply', [mint, { commitment: 'confirmed' }]),
      ]);

      const accounts: Array<{ uiAmount: number | null }> =
        largestResult.status === 'fulfilled' ? (largestResult.value?.value ?? []) : [];
      const supply: number | null =
        supplyResult.status === 'fulfilled'
          ? (supplyResult.value?.value?.uiAmount ?? null)
          : null;

      let top10ConcentrationPct: number | undefined;
      if (accounts.length > 0 && supply && supply > 0) {
        const top10 = accounts.slice(0, 10);
        const top10Sum = top10.reduce((s, a) => s + (a.uiAmount ?? 0), 0);
        top10ConcentrationPct = Math.min(100, (top10Sum / supply) * 100);
      }

      // Bundle detection: RugCheck already flags it in risks[] — save RPC calls
      const bundleDetected = Array.isArray(rugcheckRisks)
        ? rugcheckRisks.some((r) => /bundle/i.test(r?.name ?? ''))
        : undefined;

      return {
        top10ConcentrationPct,
        bundleDetected,
      };
    } catch (e: any) {
      this.logger.warn(`Holder metrics failed for ${mint}: ${e.message}`);
      return null;
    }
  }

  private async rpcCall(method: string, params: unknown[]): Promise<any> {
    const res = await fetch(this.rpcUrl!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`Helius RPC ${method} returned ${res.status}`);
    const body = await res.json();
    if (body.error) throw new Error(`Helius RPC ${method} error: ${JSON.stringify(body.error)}`);
    return body.result;
  }
}
