import { Injectable, Logger } from '@nestjs/common';
import type { SmartMoneyResult } from '../token-analysis.types';
import { SMART_MONEY_WALLETS } from '../smart-money-wallets';

const TIMEOUT_MS = 5_000;
const MAX_WALLETS = 30; // cap to bound worst-case latency

/**
 * Checks how many wallets from our curated smart-money list hold a given token.
 * Uses Helius getTokenAccountsByOwner — free, standard Solana RPC.
 * All wallets checked in parallel (capped at MAX_WALLETS) with per-call timeout.
 */
@Injectable()
export class SmartMoneyProvider {
  private readonly logger = new Logger(SmartMoneyProvider.name);
  private readonly rpcUrl: string | null;

  constructor() {
    this.rpcUrl = process.env.HELIUS_RPC_URL ?? null;
  }

  async check(mint: string, chain: 'SOLANA' | 'EVM'): Promise<SmartMoneyResult> {
    const empty: SmartMoneyResult = { walletsChecked: 0, holdersFound: 0, holders: [] };
    if (chain !== 'SOLANA' || !this.rpcUrl || SMART_MONEY_WALLETS.length === 0) return empty;

    const wallets = SMART_MONEY_WALLETS.slice(0, MAX_WALLETS);

    // All wallets in parallel — each has its own timeout so one slow call can't stall the rest
    const results = await Promise.allSettled(
      wallets.map((w) => this.holds(w.address, mint)),
    );

    const holders: SmartMoneyResult['holders'] = [];
    for (let i = 0; i < wallets.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled' && r.value) {
        holders.push({ label: wallets[i].label });
      }
    }

    return {
      walletsChecked: wallets.length,
      holdersFound: holders.length,
      holders,
    };
  }

  private async holds(walletAddress: string, mint: string): Promise<boolean> {
    if (!this.rpcUrl) return false;
    try {
      const res = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'sm',
          method: 'getTokenAccountsByOwner',
          params: [walletAddress, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }],
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) return false;
      const body = await res.json();
      const accounts: any[] = body?.result?.value ?? [];
      return accounts.some(
        (a) => Number(a?.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0) > 0,
      );
    } catch {
      return false;
    }
  }
}
