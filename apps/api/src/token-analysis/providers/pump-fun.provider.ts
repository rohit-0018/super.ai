import { Injectable, Logger } from '@nestjs/common';
import { HttpError, http } from '../../common/http';
import { isPumpFunMint } from './pump-fun.util';

export interface PumpFunCoinData {
  mint: string;
  name: string;
  symbol: string;
  description: string;
  imageUri: string;
  creator: string;
  createdAt: number; // ms epoch
  lastTradeAt: number | null;
  /** Current market cap in USD (pump.fun's own valuation). */
  marketCapUsd: number;
  /** ATH market cap in USD. */
  athMarketCapUsd: number;
  athAt: number | null;
  /**
   * Bonding curve progress: 0–100. Computed from real SOL reserves against the
   * graduation threshold (~85 SOL). If `graduated` is true, this is 100.
   * Note: pump.fun has tweaked the curve mechanics over time — treat as an
   * approximation, not an exact %.
   */
  bondingCurvePct: number;
  graduated: boolean;
  /** True when the creator is currently streaming on pump.fun's livestream feature. */
  isLive: boolean;
  /** Number of replies/comments on the pump.fun coin page — proxy for community heat. */
  replyCount: number;
  twitter: string | null;
  telegram: string | null;
  website: string | null;
  nsfw: boolean;
}

/**
 * Direct pump.fun integration via their frontend-api-v3 endpoint.
 *
 * Why this exists: pump.fun bonding-curve tokens (mints ending in "pump") have
 * no Raydium/PumpSwap pool until they graduate, so Jupiter / Birdeye / Moralis
 * either 404 or return stale data for pre-graduation tokens. Pump.fun itself
 * is the only authoritative source for: bonding curve %, ATH MC, livestream
 * status, reply count, and creator socials prior to graduation.
 *
 * The v3 endpoint is unauthenticated and unrate-limited at the time of writing,
 * but is fronted by Cloudflare — a UA header is required (530 otherwise).
 *
 * Endpoint: https://frontend-api-v3.pump.fun/coins/&lt;mint&gt;
 */
@Injectable()
export class PumpFunProvider {
  private readonly logger = new Logger(PumpFunProvider.name);
  private readonly base = 'https://frontend-api-v3.pump.fun';
  // Approximate real-SOL reserves at graduation. pump.fun's curve targets
  // ~$69k market cap which corresponds to ~85 SOL at typical SOL prices.
  private static readonly GRADUATION_LAMPORTS = 85 * 1_000_000_000;
  // 60s TTL cache. Dynamic fields (bondingCurvePct, marketCapUsd, replyCount)
  // change fast on pump.fun but a 1-minute granularity is plenty for scoring
  // purposes and keeps us under Cloudflare's tolerance when the hot scan
  // fans out over many candidates per cycle.
  private static readonly CACHE_TTL_MS = 60_000;
  private readonly cache = new Map<string, { data: PumpFunCoinData | null; ts: number }>();

  /**
   * Fetches the pump.fun coin record for a mint. Returns null for non-pump
   * tokens (suffix guard) or when the endpoint 404s.
   * Cached for 60s per mint.
   */
  async getCoinData(mint: string): Promise<PumpFunCoinData | null> {
    if (!isPumpFunMint(mint)) return null;
    const hit = this.cache.get(mint);
    if (hit && Date.now() - hit.ts < PumpFunProvider.CACHE_TTL_MS) return hit.data;
    try {
      const data = await http.get<any>(`${this.base}/coins/${mint}`, {
        // Cloudflare 530s on missing UA; this header is enough to pass.
        headers: { 'User-Agent': 'qwai/1.0 (+https://qwai.io)' },
        timeoutMs: 6_000,
      });
      if (!data || !data.mint) return null;

      const graduated = !!data.complete;
      const realSolReserves = Number(data.real_sol_reserves ?? 0);
      const bondingCurvePct = graduated
        ? 100
        : Math.min(99, Math.max(0, (realSolReserves / PumpFunProvider.GRADUATION_LAMPORTS) * 100));

      const result: PumpFunCoinData = {
        mint: String(data.mint),
        name: String(data.name ?? ''),
        symbol: String(data.symbol ?? ''),
        description: String(data.description ?? ''),
        imageUri: String(data.image_uri ?? ''),
        creator: String(data.creator ?? ''),
        createdAt: Number(data.created_timestamp ?? 0),
        lastTradeAt: data.last_trade_timestamp ? Number(data.last_trade_timestamp) : null,
        marketCapUsd: Number(data.usd_market_cap ?? 0),
        athMarketCapUsd: Number(data.ath_market_cap ?? 0),
        athAt: data.ath_market_cap_timestamp ? Number(data.ath_market_cap_timestamp) : null,
        bondingCurvePct,
        graduated,
        isLive: !!data.is_currently_live,
        replyCount: Number(data.reply_count ?? 0),
        twitter: typeof data.twitter === 'string' && data.twitter ? data.twitter : null,
        telegram: typeof data.telegram === 'string' && data.telegram ? data.telegram : null,
        website: typeof data.website === 'string' && data.website ? data.website : null,
        nsfw: !!data.nsfw,
      };
      this.cache.set(mint, { data: result, ts: Date.now() });
      return result;
    } catch (e: any) {
      if (e instanceof HttpError && e.status === 404) {
        // Cache the negative result too — saves us from polling dead mints.
        this.cache.set(mint, { data: null, ts: Date.now() });
        return null;
      }
      this.logger.debug(`pump.fun coin data failed for ${mint}: ${e.message}`);
      return null;
    }
  }

  /**
   * Batch fetch with concurrency cap. Returns only successful (non-null)
   * results, keyed by mint. Used by the hot-tokens scanner to enrich
   * pump-suffix candidates without serially blocking on slow responses.
   */
  async getCoinDataBatch(mints: string[], concurrency = 5): Promise<Map<string, PumpFunCoinData>> {
    const out = new Map<string, PumpFunCoinData>();
    const eligible = mints.filter(isPumpFunMint);
    for (let i = 0; i < eligible.length; i += concurrency) {
      const chunk = eligible.slice(i, i + concurrency);
      const results = await Promise.all(chunk.map((m) => this.getCoinData(m).catch(() => null)));
      results.forEach((r, idx) => { if (r) out.set(chunk[idx], r); });
    }
    return out;
  }
}
