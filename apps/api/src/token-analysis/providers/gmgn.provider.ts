import { Injectable, Logger } from '@nestjs/common';
import type { SmartMoneySignal } from '../token-analysis.types';

/**
 * GMGN smart-money wallet intelligence.
 * GMGN tracks 800K+ wallets across SOL/ETH/BSC/Base, labels them by PnL + win rate.
 *
 * There is no official public API — this uses GMGN's token traders endpoint
 * which is accessible without authentication (subject to change).
 * Rate limit: very conservative (10/min). Aggressive cooldown on 429.
 *
 * No API key required. Best-effort — gracefully returns null on failure.
 */
@Injectable()
export class GmgnProvider {
  private readonly logger = new Logger(GmgnProvider.name);

  /**
   * Returns smart-money wallets that hold/bought the token.
   * Checks top-50 traders for any with GMGN "smart" label.
   */
  async getSmartMoneySignals(
    mint: string,
    chain: 'sol' | 'eth' | 'bsc' | 'base' = 'sol',
  ): Promise<SmartMoneySignal[] | null> {
    const url = `https://gmgn.ai/defi/quotation/v1/tokens/top_traders/${chain}/${mint}`;

    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; qwai/1.0)',
          Accept: 'application/json',
          Referer: 'https://gmgn.ai/',
        },
        signal: AbortSignal.timeout(4_000),
      });

      if (!res.ok) {
        if (res.status === 429) {
          const err = new Error('GMGN rate limit') as any;
          err.status = 429;
          throw err;
        }
        if (res.status === 404 || res.status === 400) return null;
        this.logger.warn(`GMGN non-200 for ${mint}: ${res.status}`);
        return null;
      }

      const body = await res.json() as any;
      const traders: any[] = body?.data?.traders ?? body?.traders ?? [];
      if (!traders.length) return [];

      const signals: SmartMoneySignal[] = [];
      for (const t of traders.slice(0, 50)) {
        const isSmartMoney =
          t.tags?.includes('smart_degen') ||
          t.tags?.includes('smart_money') ||
          t.is_smart_money ||
          (t.winrate != null && Number(t.winrate) >= 0.65 && Number(t.realized_profit) > 5000);

        if (!isSmartMoney) continue;

        signals.push({
          walletAddress: t.address ?? t.wallet ?? '',
          label: t.name ?? t.ens ?? undefined,
          winRate: t.winrate != null ? Math.round(Number(t.winrate) * 100) : undefined,
          action: t.sell_30d > 0 ? 'sold' : 'holding',
          amountUsd: t.realized_profit != null ? Number(t.realized_profit) : undefined,
          source: 'gmgn',
        });

        if (signals.length >= 5) break;
      }

      return signals;
    } catch (e: any) {
      if (e?.status === 429) throw e;
      this.logger.warn(`GMGN failed for ${mint}: ${e.message}`);
      return null;
    }
  }
}
