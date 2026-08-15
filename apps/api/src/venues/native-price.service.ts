/**
 * USD price of each chain's native gas asset.
 *
 * Needed because every buy is denominated in USD by the user but must be
 * submitted in native base units (lamports / wei). Getting this wrong by even a
 * few percent silently mis-sizes every trade, so it is worth a dedicated,
 * cached, multi-source lookup rather than the hardcoded `?? 140` SOL fallback
 * that hot-tokens.controller.ts currently uses.
 *
 * Sources, in order: DexScreener (free, no key, already a dependency) then
 * CoinGecko simple/price (free). Both are cross-checked against a sanity band
 * so a garbage upstream response can't produce a 100x-oversized order.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ALL_CHAINS, getChain, type ChainKey, type ChainSpec } from './chain-registry';

const CACHE_TTL_MS = 30_000;

/**
 * Last-resort values used only when every upstream fails. Deliberately
 * conservative (low) — undersizing a trade is recoverable, oversizing is not.
 */
const FALLBACK_USD: Record<string, number> = {
  SOL: 120,
  ETH: 2_000,
  BNB: 500,
  POL: 0.3,
  AVAX: 20,
};

/** CoinGecko ids for native assets, used by the secondary source. */
const CG_IDS: Record<string, string> = {
  SOL: 'solana',
  ETH: 'ethereum',
  BNB: 'binancecoin',
  POL: 'matic-network',
  AVAX: 'avalanche-2',
};

interface Entry {
  usd: number;
  at: number;
}

@Injectable()
export class NativePriceService {
  private readonly logger = new Logger(NativePriceService.name);
  private cache = new Map<string, Entry>();
  private inflight = new Map<string, Promise<number>>();

  /** USD price of the native asset for a chain. Never throws. */
  async priceFor(chain: ChainKey | ChainSpec): Promise<number> {
    const spec = typeof chain === 'string' ? getChain(chain) : chain;
    const symbol = spec.nativeSymbol;

    const hit = this.cache.get(symbol);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.usd;

    // Collapse concurrent callers onto one upstream request. Without this a
    // burst of buys on the same chain fans out into N identical fetches.
    const existing = this.inflight.get(symbol);
    if (existing) return existing;

    const p = this.fetchPrice(spec)
      .then((usd) => {
        this.cache.set(symbol, { usd, at: Date.now() });
        return usd;
      })
      .finally(() => this.inflight.delete(symbol));

    this.inflight.set(symbol, p);
    return p;
  }

  /** Prices for every registered chain's native asset, deduped by symbol. */
  async allPrices(): Promise<Record<string, number>> {
    const symbols = [...new Set(ALL_CHAINS.map((c) => c.nativeSymbol))];
    const specs = symbols.map((s) => ALL_CHAINS.find((c) => c.nativeSymbol === s)!);
    const prices = await Promise.all(specs.map((s) => this.priceFor(s)));
    return Object.fromEntries(symbols.map((s, i) => [s, prices[i]]));
  }

  private async fetchPrice(spec: ChainSpec): Promise<number> {
    const symbol = spec.nativeSymbol;
    const fallback = FALLBACK_USD[symbol] ?? 1;

    const fromDex = await this.dexScreenerPrice(spec).catch(() => null);
    if (this.plausible(fromDex, fallback)) return fromDex!;

    const fromCg = await this.coinGeckoPrice(symbol).catch(() => null);
    if (this.plausible(fromCg, fallback)) return fromCg!;

    this.logger.warn(`No live price for ${symbol}; using fallback $${fallback}`);
    return fallback;
  }

  /**
   * Rejects values more than 20x above or below the fallback. A live price can
   * legitimately drift far from a hardcoded constant over time, so the band is
   * wide — it is there to catch upstream returning 0, null-coerced-to-0, or a
   * value in the wrong unit, not to police normal volatility.
   */
  private plausible(v: number | null, fallback: number): boolean {
    if (v == null || !Number.isFinite(v) || v <= 0) return false;
    return v < fallback * 20 && v > fallback / 20;
  }

  private async dexScreenerPrice(spec: ChainSpec): Promise<number | null> {
    const res = await fetch(
      `https://api.dexscreener.com/tokens/v1/${spec.ids.dexscreener}/${spec.wrappedNative}`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(4_000) },
    );
    if (!res.ok) return null;
    const pairs = (await res.json()) as any[];
    if (!Array.isArray(pairs) || !pairs.length) return null;

    // Deepest pool is the most trustworthy print.
    const best = pairs.sort((a, b) => (b?.liquidity?.usd ?? 0) - (a?.liquidity?.usd ?? 0))[0];
    const n = Number(best?.priceUsd);
    return Number.isFinite(n) ? n : null;
  }

  private async coinGeckoPrice(symbol: string): Promise<number | null> {
    const id = CG_IDS[symbol];
    if (!id) return null;
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(4_000) },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as any;
    const n = Number(body?.[id]?.usd);
    return Number.isFinite(n) ? n : null;
  }
}
