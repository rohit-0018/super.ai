import { Injectable, Logger } from '@nestjs/common';
import type { SmartMoneySignal } from '../token-analysis.types';

/**
 * Arkham Intelligence — free tier entity labeling.
 * Maps wallet addresses to real-world entities (funds, exchanges, known traders).
 * 800M+ labels across 450K+ entities.
 *
 * Free web API (no key for basic entity lookup).
 * Rate limit: conservative 20/min.
 *
 * Docs: https://platform.arkhamintelligence.com/docs/api
 */
@Injectable()
export class ArkhamProvider {
  private readonly logger = new Logger(ArkhamProvider.name);
  private readonly base = 'https://api.arkhamintelligence.com';

  /**
   * Look up entity labels for a list of wallet addresses.
   * Returns enriched signals with entity names attached.
   */
  async enrichWallets(
    wallets: string[],
    signals: SmartMoneySignal[],
  ): Promise<SmartMoneySignal[]> {
    if (!wallets.length) return signals;

    // Arkham free endpoint: entity lookup by address
    const enriched = await Promise.allSettled(
      wallets.slice(0, 10).map((addr) => this.lookupAddress(addr)),
    );

    const labelMap = new Map<string, string>();
    for (let i = 0; i < enriched.length; i++) {
      const r = enriched[i];
      if (r.status === 'fulfilled' && r.value) {
        labelMap.set(wallets[i].toLowerCase(), r.value);
      }
    }

    return signals.map((s) => ({
      ...s,
      label: labelMap.get(s.walletAddress.toLowerCase()) ?? s.label,
    }));
  }

  private async lookupAddress(address: string): Promise<string | null> {
    try {
      const res = await fetch(`${this.base}/intelligence/address/${address}`, {
        headers: { Accept: 'application/json', 'User-Agent': 'qwai/1.0' },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return null;
      const body = await res.json() as any;
      // Arkham returns entity name and type
      const name = body?.entity?.name ?? body?.name;
      return typeof name === 'string' ? name : null;
    } catch {
      return null;
    }
  }
}
