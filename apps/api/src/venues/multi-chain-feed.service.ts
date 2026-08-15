/**
 * The token feed behind the network chooser.
 *
 * `GET /api/venues/feed?network=all` returns every chain; `?network=base`
 * returns just Base. Both are served from the same in-memory snapshot, so
 * switching networks in the UI is instant — no upstream call on the read path.
 *
 * Rate-limit budget (all free tiers, no keys):
 *   DexScreener token-boosts + token-profiles   2 calls/scan, covers ALL chains
 *   DexScreener tokens/v1 batch hydrate         ~1 call per chain per scan
 *   GeckoTerminal new_pools                     30 req/min cap — see rotation below
 *
 * GeckoTerminal is per-network (`/networks/{slug}/new_pools`), so covering 9
 * chains every tick would burn 9 of our 30 calls/min just on freshness. Instead
 * we rotate: each scan pulls new_pools for GECKO_CHAINS_PER_TICK chains, cycling
 * through the list. Every chain is refreshed within a few ticks and we stay well
 * inside the free tier even if the interval is tightened.
 */

import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ALL_CHAINS, getChain, type ChainKey, type ChainSpec } from './chain-registry';
import { DexScreenerClient, dedupeByLiquidity } from './providers/dexscreener.client';
import type { FeedResult, FeedToken, NetworkFilter } from './venue.types';

const SCAN_INTERVAL_MS = Number(process.env.VENUE_FEED_INTERVAL_MS ?? 45_000);
const GECKO_CHAINS_PER_TICK = Number(process.env.VENUE_FEED_GECKO_PER_TICK ?? 3);
const MAX_PER_CHAIN = Number(process.env.VENUE_FEED_MAX_PER_CHAIN ?? 60);
/** A snapshot older than this is served but flagged `stale: true`. */
const STALE_AFTER_MS = SCAN_INTERVAL_MS * 3;

const GECKO_BASE = 'https://api.geckoterminal.com/api/v2';

@Injectable()
export class MultiChainFeedService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MultiChainFeedService.name);

  /** chainKey → rows, kept per-chain so a single chain failing never blanks the feed. */
  private byChain = new Map<ChainKey, FeedToken[]>();
  private lastScanAt: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private scanning = false;
  private geckoCursor = 0;

  constructor(@Optional() private readonly dex: DexScreenerClient) {}

  onModuleInit() {
    if (process.env.VENUE_FEED_ENABLED === 'false') {
      this.logger.log('Multi-chain feed disabled (VENUE_FEED_ENABLED=false)');
      return;
    }
    // Kick off immediately so the first request isn't cold, then on interval.
    void this.scan();
    this.timer = setInterval(() => void this.scan(), SCAN_INTERVAL_MS);
    // Never let the feed hold the process open during shutdown.
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Read path — pure in-memory, safe to call at UI refresh rates. */
  getFeed(network: NetworkFilter = 'all', limit = 100): FeedResult {
    const countsByChain: Record<string, number> = {};
    for (const [k, rows] of this.byChain) countsByChain[k] = rows.length;

    let tokens: FeedToken[];
    if (network === 'all') {
      // Interleave by liquidity so one deep chain can't crowd out the rest.
      tokens = dedupeByLiquidity([...this.byChain.values()].flat())
        .sort((a, b) => b.volume24hUsd - a.volume24hUsd);
    } else {
      tokens = [...(this.byChain.get(network) ?? [])].sort(
        (a, b) => b.volume24hUsd - a.volume24hUsd,
      );
    }

    return {
      tokens: tokens.slice(0, limit),
      countsByChain,
      network,
      fetchedAt: this.lastScanAt ? new Date(this.lastScanAt).toISOString() : new Date(0).toISOString(),
      stale: this.lastScanAt == null || Date.now() - this.lastScanAt > STALE_AFTER_MS,
    };
  }

  /** Networks the chooser should render, with live counts. */
  getNetworks() {
    return [
      {
        key: 'all' as const,
        name: 'All Networks',
        count: [...this.byChain.values()].reduce((n, r) => n + r.length, 0),
      },
      ...ALL_CHAINS.map((c) => ({
        key: c.key,
        name: c.displayName,
        family: c.family,
        evmChainId: c.evmChainId,
        nativeSymbol: c.nativeSymbol,
        count: this.byChain.get(c.key)?.length ?? 0,
      })),
    ];
  }

  async scan(): Promise<void> {
    if (this.scanning || !this.dex) return;
    this.scanning = true;
    const started = Date.now();

    try {
      // 1. Broad cross-chain discovery — 2 calls, every chain.
      const discovered = await this.dex.discoverAcrossChains();

      const addrsByChain = new Map<ChainKey, string[]>();
      for (const d of discovered) {
        const list = addrsByChain.get(d.chain.key) ?? [];
        list.push(d.address);
        addrsByChain.set(d.chain.key, list);
      }

      // 2. Fresh launches from GeckoTerminal for a rotating subset of chains.
      const rotating = this.nextGeckoChains();
      const geckoResults = await Promise.all(
        rotating.map((c) => this.geckoNewPools(c).catch(() => [] as FeedToken[])),
      );
      const geckoByChain = new Map<ChainKey, FeedToken[]>();
      rotating.forEach((c, i) => geckoByChain.set(c.key, geckoResults[i] ?? []));

      // 3. Hydrate discovery addresses per chain, in parallel across chains.
      const chainKeys = [...new Set([...addrsByChain.keys(), ...rotating.map((c) => c.key)])];
      const hydrated = await Promise.all(
        chainKeys.map(async (key) => {
          const spec = getChain(key);
          const addrs = addrsByChain.get(key) ?? [];
          const rows: FeedToken[] = [];

          if (addrs.length) {
            const pairs = await this.dex.pairsForTokens(spec, addrs).catch(() => new Map());
            for (const [, pair] of pairs) {
              const t = this.dex.toFeedToken(spec, pair, 'dexscreener_boost');
              if (t) rows.push(t);
            }
          }
          rows.push(...(geckoByChain.get(key) ?? []));
          return [key, rows] as const;
        }),
      );

      // 4. Commit per chain. Chains that returned nothing this tick keep their
      //    previous rows rather than blanking — a transient upstream failure
      //    should not empty the user's screen.
      let total = 0;
      for (const [key, rows] of hydrated) {
        const clean = dedupeByLiquidity(rows)
          .filter((r) => r.liquidityUsd > 0)
          .sort((a, b) => b.volume24hUsd - a.volume24hUsd)
          .slice(0, MAX_PER_CHAIN);
        if (clean.length) {
          this.byChain.set(key, clean);
          total += clean.length;
        }
      }

      this.lastScanAt = Date.now();
      this.logger.log(
        `Feed scan: ${total} tokens across ${this.byChain.size} chains ` +
        `(gecko: ${rotating.map((c) => c.key).join(',')}) in ${Date.now() - started}ms`,
      );
    } catch (e: any) {
      this.logger.warn(`Feed scan failed: ${e?.message}`);
    } finally {
      this.scanning = false;
    }
  }

  /**
   * Advances the rotation cursor and returns the next slice of chains.
   *
   * The very first scan sweeps every chain instead of a slice: otherwise the
   * network chooser boots with several chains showing zero tokens and fills in
   * over the following minutes, which reads as broken. One 9-call burst at
   * startup is well within GeckoTerminal's 30/min free tier.
   */
  private nextGeckoChains(): ChainSpec[] {
    if (this.lastScanAt == null) return [...ALL_CHAINS];

    const n = Math.max(1, Math.min(GECKO_CHAINS_PER_TICK, ALL_CHAINS.length));
    const out: ChainSpec[] = [];
    for (let i = 0; i < n; i++) {
      out.push(ALL_CHAINS[(this.geckoCursor + i) % ALL_CHAINS.length]);
    }
    this.geckoCursor = (this.geckoCursor + n) % ALL_CHAINS.length;
    return out;
  }

  /** GeckoTerminal new pools for one network — catches launches before boosts. */
  private async geckoNewPools(chain: ChainSpec): Promise<FeedToken[]> {
    const url = `${GECKO_BASE}/networks/${chain.ids.geckoterminal}/new_pools?include=base_token`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json;version=20230302', 'User-Agent': 'qwai/1.0' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as any;

    // `included` carries the base_token entities referenced by each pool.
    const tokenById = new Map<string, any>(
      (body?.included ?? []).map((t: any) => [t.id, t.attributes]),
    );

    const rows: FeedToken[] = [];
    for (const pool of body?.data ?? []) {
      const a = pool?.attributes;
      if (!a) continue;
      const tokenId = pool?.relationships?.base_token?.data?.id;
      const tok = tokenId ? tokenById.get(tokenId) : null;
      const address = tok?.address;
      const priceUsd = Number(a.base_token_price_usd);
      if (!address || !Number.isFinite(priceUsd)) continue;

      const createdAt = a.pool_created_at ? new Date(a.pool_created_at).getTime() : null;

      rows.push({
        chain: chain.key,
        chainName: chain.displayName,
        address,
        symbol: tok?.symbol ?? '???',
        name: tok?.name ?? 'Unknown',
        priceUsd,
        priceChange5m: numOr(a.price_change_percentage?.m5),
        priceChange1h: numOr(a.price_change_percentage?.h1),
        priceChange24h: numOr(a.price_change_percentage?.h24),
        volume24hUsd: numOr(a.volume_usd?.h24) ?? 0,
        liquidityUsd: numOr(a.reserve_in_usd) ?? 0,
        marketCapUsd: numOr(a.market_cap_usd) ?? undefined,
        fdvUsd: numOr(a.fdv_usd) ?? undefined,
        pairAddress: a.address,
        pairAgeHours: createdAt ? Math.max(0, (Date.now() - createdAt) / 3_600_000) : undefined,
        dex: pool?.relationships?.dex?.data?.id,
        source: 'geckoterminal_new',
        dexUrl: `https://www.geckoterminal.com/${chain.ids.geckoterminal}/pools/${a.address}`,
        tradable: true,
      });
    }
    return rows;
  }
}

function numOr(v: unknown): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
