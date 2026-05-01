import { Injectable, Logger } from '@nestjs/common';
import { HttpError, http } from '../../common/http';
import type { BundleInfo } from '../token-analysis.types';

/**
 * Bundle detection via Trench / BundleChecker API (trench.bot).
 * Detects wallets that co-purchased tokens in Jito atomic bundles at launch,
 * indicating a coordinated insider grab.
 *
 * Primary endpoint: trench.bot API (free, no auth)
 * Falls back to RugCheck bundle risk flag (already fetched by safety layer).
 *
 * No API key required. Rate limit: conservative 20/min.
 */
@Injectable()
export class BundleCheckerProvider {
  private readonly logger = new Logger(BundleCheckerProvider.name);
  private readonly base = 'https://trench.bot/api';

  async getBundleInfo(mint: string): Promise<BundleInfo | null> {
    try {
      // trench.bot provides a direct token → bundle analysis endpoint
      const data = await http.get<any>(`${this.base}/bundle/analyse/${mint}`, {
        timeoutMs: 12_000,
        headers: { 'User-Agent': 'qwai/1.0' },
      });
      if (!data) return null;

      const bundled = data.bundled ?? data.uniqueBundlers ?? 0;
      const totalSupplyPct = data.holdingPercentage ?? data.totalBundledPct;
      const wallets: string[] = Array.isArray(data.bundledWallets)
        ? data.bundledWallets.slice(0, 10)
        : Array.isArray(data.topBundlers)
        ? data.topBundlers.slice(0, 10).map((b: any) => b.wallet ?? b.address ?? '')
        : [];

      const detected = bundled > 0 || (totalSupplyPct != null && totalSupplyPct > 1);

      return {
        detected,
        bundleCount: bundled > 0 ? bundled : undefined,
        bundledSupplyPct: totalSupplyPct != null ? Math.min(100, Number(totalSupplyPct)) : undefined,
        bundledWallets: wallets.filter(Boolean),
        source: 'trench.bot',
      };
    } catch (e: any) {
      if (e instanceof HttpError) {
        // 404 = no bundle data found (clean token or too new)
        if (e.status === 404) return { detected: false, source: 'trench.bot' };
        if (e.status === 429) throw e; // let pool handle rate limit
      }
      this.logger.warn(`BundleChecker failed for ${mint}: ${e.message}`);
      return null;
    }
  }

  /**
   * Extract bundle signal from RugCheck risks array (already available
   * from the safety layer — zero extra HTTP call).
   */
  fromRugcheckRisks(risks: Array<{ name?: string; level?: string; description?: string }>): BundleInfo | null {
    const bundleRisk = risks.find((r) => /bundle/i.test(r.name ?? ''));
    if (!bundleRisk) return null;

    // RugCheck description may contain "X% of supply bundled"
    const pctMatch = (bundleRisk.description ?? '').match(/(\d+(?:\.\d+)?)\s*%/);
    const pct = pctMatch ? parseFloat(pctMatch[1]) : undefined;

    return {
      detected: true,
      bundledSupplyPct: pct,
      source: 'rugcheck',
    };
  }
}
