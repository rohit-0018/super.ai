import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Optional, Inject } from '@nestjs/common';
import IORedis from 'ioredis';
import { buildRedisOptions } from '../common/redis-options';
import { RealtimeGateway } from '../ws/realtime.gateway';
import { TokenAnalysisService } from '../token-analysis/token-analysis.service';
import { IntelSnapshotService } from '../intel-track/intel-snapshot.service';
import { SignalPipelineService } from './signal-pipeline.service';
import { TokenPoolService } from './token-pool.service';
import { getProfile } from '../token-analysis/profile.config';
import { fmtPriceUsd } from '../common/format-price';
import { PumpFunProvider, type PumpFunCoinData } from '../token-analysis/providers/pump-fun.provider';
import { isPumpFunMint } from '../token-analysis/providers/pump-fun.util';
import { computeHotTokenScore } from './scoring';
import type { TradingProfile } from '../token-analysis/profile.config';
import type {
  AllProfilesScan,
  HotToken,
  HotTokenSource,
  HotTokensScan,
  HotTokenVerdict,
} from './hot-tokens.types';

const STREAK_THRESHOLD = parseInt(process.env.HOT_STREAK_THRESHOLD ?? '3', 10);
// Streaks expire after the max age window so tokens auto-clear when they age out.
const STREAK_TTL_SEC = Math.ceil(parseFloat(process.env.HOT_TOKEN_MAX_AGE_HOURS ?? '4') * 3600);

interface PumpStreak {
  address: string;
  symbol: string;
  priceUsd: number;
  priceChange1h: number;
  score: number;
  count: number;
  firstSeenAt: string;
  profileKey: string;
}

const streakKey = (address: string) => `qwai:streak:${address}`;

const SCAN_INTERVAL_MS = parseInt(process.env.HOT_SCAN_INTERVAL_MS ?? '20000', 10);
const REDIS_TTL_SEC = Math.ceil((SCAN_INTERVAL_MS * 3) / 1_000); // 3 × interval — survives two missed ticks
const MAX_PER_PROFILE = 12;
const ALL_PROFILES: TradingProfile[] = [
  'meme_hunter', 'degen_sniper', 'swing_trader', 'gem_hunt', 'alpha_hunt',
];

const DEX_BOOSTS_URL = 'https://api.dexscreener.com/token-boosts/latest/v1';
const DEX_PROFILES_URL = 'https://api.dexscreener.com/token-profiles/latest/v1';
const DEX_TOKENS_URL = 'https://api.dexscreener.com/latest/dex/tokens';
const GECKO_NEW_POOLS_URL = 'https://api.geckoterminal.com/api/v2/networks/solana/new_pools?include=base_token';
const GECKO_TRENDING_URL = 'https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?include=base_token';
const GECKO_ACCEPT = 'application/json;version=20230302';

const redisKey = (profileKey: string) => `qwai:hot:${profileKey}`;

interface DexTokenData {
  address: string;
  symbol: string;
  name: string;
  priceUsd: number;
  priceChange5m: number;
  priceChange1h: number;
  priceChange24h: number;
  volume24hUsd: number;
  marketCapUsd: number;
  liquidityUsd: number;
  pairAgeHours: number;
  dexUrl?: string;
  launchPlatform?: string;
  // Phase 1 gem-hunter signals — DexScreener tape quality. Optional because
  // GeckoTerminal/pump.fun fallback paths don't always populate them.
  buys1h?: number;
  sells1h?: number;
  buys5m?: number;
  sells5m?: number;
  volume1hUsd?: number;
  volume5mUsd?: number;
}

interface Candidate {
  address: string;
  source: HotTokenSource;
  geckoRaw?: DexTokenData;
  /** Pump.fun frontend-api-v3 enrichment (bonding %, replyCount, isLive, etc.).
   *  Populated only for mints with the "pump" suffix; null for everything else. */
  pumpFunData?: PumpFunCoinData;
}

@Injectable()
export class HotTokensService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HotTokensService.name);
  readonly enabled = process.env.HOT_TOKENS_ENABLED !== 'false';
  readonly fastScan = process.env.HOT_TOKENS_FAST_SCAN === 'true';

  private redis: IORedis;
  private scanCache = new Map<string, { scan: HotTokensScan; ts: number }>();
  private priceRefreshCache = new Map<string, HotToken>();
  private scanning = false;
  private prewarming = false;
  private lastRedisErrorLog = 0;
  private cacheRefreshInterval?: NodeJS.Timeout;

  constructor(
    @Optional() private readonly realtime: RealtimeGateway,
    private readonly tokenAnalysis: TokenAnalysisService,
    @Optional() private readonly intelSnapshots: IntelSnapshotService,
    @Optional() private readonly signalPipeline: SignalPipelineService,
    @Optional() private readonly tokenPool: TokenPoolService,
    @Optional() private readonly pumpFun: PumpFunProvider,
  ) {
    this.redis = new IORedis(
      process.env.REDIS_URL ?? 'redis://localhost:6379',
      buildRedisOptions({ lazyConnect: true, enableReadyCheck: false }),
    );
    this.redis.on('error', (err) => {
      // Avoid log floods — only log first error per minute
      const now = Date.now();
      if (now - this.lastRedisErrorLog > 60_000) {
        this.lastRedisErrorLog = now;
        this.logger.warn(`Redis error (hot tokens fall back to in-memory): ${err.message}`);
      }
    });
  }

  async onModuleInit() {
    if (!this.enabled) return;

    // ioredis lazy-connects on first command — no explicit connect needed.
    // Warm in-memory cache from Redis so the first request is never empty.
    await this.loadFromRedis();

    // If Redis was also cold (fresh deploy), kick off the first scan immediately
    if (this.scanCache.size === 0) {
      this.logger.log('Cold start — triggering immediate hot tokens scan');
      setImmediate(() => this.scan());
    } else {
      this.logger.log(`Warmed ${this.scanCache.size} profiles from Redis`);
    }

    // Keep in-memory cache in sync with Redis so processes without BullMQ workers
    // (QWAI_ROLE=web API servers) always serve fresh data written by the worker process.
    this.cacheRefreshInterval = setInterval(
      () => { void this.loadFromRedis(); },
      SCAN_INTERVAL_MS,
    );
    this.cacheRefreshInterval.unref();
  }

  async onModuleDestroy() {
    if (this.cacheRefreshInterval) clearInterval(this.cacheRefreshInterval);
    try { await this.redis.quit(); } catch {}
  }

  // ── public API ────────────────────────────────────────────────────────────

  getLatest(profileKey: string): HotTokensScan | null {
    return this.scanCache.get(profileKey)?.scan ?? null;
  }

  getAllLatest(): AllProfilesScan | null {
    if (this.scanCache.size === 0) return null;
    const byProfile: Record<string, HotToken[]> = {};
    let scannedAt = '';
    let nextScanAt = '';
    for (const [k, { scan }] of this.scanCache) {
      byProfile[k] = scan.tokens;
      scannedAt = scan.scannedAt;
      nextScanAt = scan.nextScanAt;
    }
    return { byProfile, scannedAt, nextScanAt, scanIntervalMs: SCAN_INTERVAL_MS };
  }

  getHotTokensForAgent(profileKey: string): string {
    const scan = this.getLatest(profileKey);
    if (!scan || !scan.tokens.length) return 'No hot tokens scanned yet — the scanner runs every 20s, check back shortly.';
    const lines = scan.tokens.slice(0, 8).map(
      (t) =>
        `${t.symbol} [${t.address}] (${fmtPriceUsd(t.priceUsd)}) ` +
        `${t.priceChange1h >= 0 ? '+' : ''}${t.priceChange1h.toFixed(1)}% 1h · ` +
        `score ${t.score}/100 · ${t.verdict} · ${t.summary}`,
    );
    return `Hot tokens [${profileKey}, scanned ${scan.scannedAt}]:\n${lines.join('\n')}`;
  }

  // ── scan ──────────────────────────────────────────────────────────────────

  async scan(): Promise<void> {
    if (!this.enabled || this.scanning) return;
    this.scanning = true;
    this.logger.log('Hot tokens scan start');
    const t0 = Date.now();

    try {
      const candidates = await this.gatherCandidates();
      const enriched = await this.enrichCandidates(candidates);

      const now = new Date();
      const scannedAt = now.toISOString();
      const nextScanAt = new Date(now.getTime() + SCAN_INTERVAL_MS).toISOString();
      const byProfile: Record<string, HotToken[]> = {};

      for (const profileKey of ALL_PROFILES) {
        const tokens = this.scoreForProfile(enriched, profileKey, scannedAt);
        const scan: HotTokensScan = {
          tokens,
          profileKey,
          scannedAt,
          nextScanAt,
          scanIntervalMs: SCAN_INTERVAL_MS,
          fastScanEnabled: this.fastScan,
        };
        byProfile[profileKey] = tokens;

        // Update in-memory cache
        this.scanCache.set(profileKey, { scan, ts: Date.now() });
        for (const t of tokens) {
          this.priceRefreshCache.set(t.address, t);
          // Register into the central token pool so all UI cards share one data source
          this.tokenPool?.register(t.address, { symbol: t.symbol, source: t.source, capturedAt: t.scannedAt });
        }

        // Persist to Redis — survives restarts, cleared when next scan writes fresh data
        await this.persistToRedis(profileKey, scan);
      }

      // Bound priceRefreshCache so it doesn't grow unboundedly across scans.
      // Keep only the addresses that appeared in the latest scan + a small
      // tail of recently-seen tokens (LRU semantics) — anything older is
      // unlikely to be refreshed and just leaks memory.
      const REFRESH_CACHE_CAP = 200;
      if (this.priceRefreshCache.size > REFRESH_CACHE_CAP) {
        const keep = new Set<string>();
        for (const list of Object.values(byProfile)) for (const t of list) keep.add(t.address);
        for (const k of [...this.priceRefreshCache.keys()]) {
          if (!keep.has(k)) this.priceRefreshCache.delete(k);
          if (this.priceRefreshCache.size <= REFRESH_CACHE_CAP) break;
        }
      }

      this.logger.log(
        `Hot scan done: ${candidates.size} candidates, ${enriched.filter((e) => e.dex).length} enriched, ${Date.now() - t0}ms`,
      );

      this.realtime?.emitGlobal('hot_tokens_update', {
        byProfile,
        scannedAt,
        nextScanAt,
        scanIntervalMs: SCAN_INTERVAL_MS,
      } as AllProfilesScan);

      // Streak tracking — fire-and-forget so it never blocks the scan.
      void this.processPumpStreaks(byProfile, scannedAt);

      // Feed signal pipeline with all unique tokens from this scan.
      // New tokens jump to the front of the pipeline queue so the strongest
      // candidates get AI analysis within seconds of appearing.
      if (this.signalPipeline) {
        const allTokens = [...new Map(
          Object.values(byProfile).flat().map((t) => [t.address, t]),
        ).values()];
        this.signalPipeline.enqueue(allTokens);
      }

      // Pre-warm full analysis for unique hot addresses so clicking any chip is instant.
      // Skipped when SIGNAL_PIPELINE_ENABLED=false — prewarm runs analyzeAddress
      // which is the same LLM path the pipeline gate disables. Without this guard
      // we'd still spend tokens (and spam CoinGecko 400s on memecoin addresses).
      if (process.env.SIGNAL_PIPELINE_ENABLED !== 'false') {
        const uniqueAddrs = [...new Set(Object.values(byProfile).flat().map((t) => t.address))].slice(0, 8);
        this.prewarmAnalysis(uniqueAddrs);
      }
    } catch (err) {
      this.logger.error(`Hot scan error: ${(err as Error).message}`);
    } finally {
      this.scanning = false;
    }
  }

  /**
   * Lightweight on-demand refresh: hits DexScreener boosts + batch prices only
   * (~2 HTTP calls, ~500ms). Skips pump.fun and all-profile scoring.
   * Updates the meme_hunter cache so subsequent getLatest() calls are fresh.
   * Called by the Telegram Refresh button when cache is stale (> 45s).
   */
  async fetchTopDirect(): Promise<HotTokensScan> {
    // GeckoTerminal new pools are guaranteed fresh (< a few hours), so meme_hunter's
    // maxAgeHours filter won't remove them. Fall back to DexScreener boosts if gecko fails.
    const geckoTokens = await this.fetchGeckoTerminalPools(GECKO_NEW_POOLS_URL, 'geckoterminal_new');
    const scannedAt = new Date().toISOString();

    let candidates: Array<Candidate & { dex: DexTokenData | null }>;
    if (geckoTokens.length > 0) {
      candidates = geckoTokens.slice(0, 20).map((d) => ({
        address: d.address,
        source: 'geckoterminal_new' as HotTokenSource,
        geckoRaw: d,
        dex: d,
      }));
    } else {
      const addresses = await this.fetchDexBoosts();
      const top = addresses.slice(0, 15);
      const dexData = await this.fetchDexBatch(top);
      candidates = top.map((addr) => ({
        address: addr,
        source: 'dexscreener_boost' as HotTokenSource,
        dex: dexData.find((d) => d.address === addr) ?? null,
      }));
    }

    const tokens = this.scoreForProfile(candidates, 'meme_hunter', scannedAt);
    const scan: HotTokensScan = {
      tokens,
      profileKey: 'meme_hunter',
      scannedAt,
      nextScanAt: new Date(Date.now() + SCAN_INTERVAL_MS).toISOString(),
      scanIntervalMs: SCAN_INTERVAL_MS,
      fastScanEnabled: this.fastScan,
    };
    this.scanCache.set('meme_hunter', { scan, ts: Date.now() });
    this.logger.log(`fetchTopDirect: ${tokens.length} tokens refreshed via ${geckoTokens.length > 0 ? 'GeckoTerminal' : 'DexScreener'} fast-lane`);
    return scan;
  }

  async refreshPrices(): Promise<void> {
    if (!this.enabled || !this.fastScan) return;
    const addresses = [...this.priceRefreshCache.keys()];
    if (!addresses.length) return;

    try {
      const updates: Array<Pick<HotToken, 'address' | 'priceUsd' | 'priceChange1h' | 'priceChange5m' | 'volume24hUsd'>> = [];
      for (const chunk of this.chunk(addresses, 10)) {
        const batch = await this.fetchDexBatch(chunk);
        for (const d of batch) {
          updates.push({
            address: d.address,
            priceUsd: d.priceUsd,
            priceChange1h: d.priceChange1h,
            priceChange5m: d.priceChange5m,
            volume24hUsd: d.volume24hUsd,
          });
        }
      }
      if (updates.length) {
        this.realtime?.emitGlobal('hot_tokens_refresh', {
          tokens: updates,
          refreshedAt: new Date().toISOString(),
        });
      }
    } catch {
      // refresh failures are non-critical
    }
  }

  // ── Pre-warm analysis cache ───────────────────────────────────────────────

  private async prewarmAnalysis(addresses: string[]): Promise<void> {
    // Guard: skip entirely if a previous pre-warm is still running.
    // At short scan intervals the loop can outlast the interval; without this
    // guard multiple concurrent loops stack up and hammer provider rate limits.
    if (this.prewarming) {
      this.logger.debug('Pre-warm skipped — previous run still in progress');
      return;
    }
    this.prewarming = true;
    try {
      for (const address of addresses) {
        try {
          // analyzeAddress runs the full pipeline (market + safety + holders + social + smart-money + AI)
          // and persists to DB with a 12-min TTL. Subsequent clicks serve from that DB cache instantly.
          await this.tokenAnalysis.analyzeAddress(address, false, 'hot_tokens_scan');
          this.logger.debug(`Pre-warmed analysis for ${address}`);
        } catch (err) {
          this.logger.debug(`Pre-warm skipped for ${address}: ${(err as Error).message}`);
        }
        // Stagger calls: 2.5s apart to avoid hammering provider rate limits.
        await new Promise((r) => setTimeout(r, 2_500));
      }
      this.logger.log(`Pre-warm complete for ${addresses.length} hot token addresses`);
    } finally {
      this.prewarming = false;
    }
  }

  // ── Redis helpers ─────────────────────────────────────────────────────────

  private async persistToRedis(profileKey: string, scan: HotTokensScan) {
    try {
      await this.redis.setex(redisKey(profileKey), REDIS_TTL_SEC, JSON.stringify(scan));
    } catch (err) {
      this.logger.warn(`Redis write failed for ${profileKey}: ${(err as Error).message}`);
    }
  }

  private async loadFromRedis() {
    for (const profileKey of ALL_PROFILES) {
      try {
        const raw = await this.redis.get(redisKey(profileKey));
        if (!raw) continue;
        const scan = JSON.parse(raw) as HotTokensScan;
        this.scanCache.set(profileKey, { scan, ts: Date.now() });
        for (const t of scan.tokens) this.priceRefreshCache.set(t.address, t);
      } catch {
        // skip corrupted entries
      }
    }
  }

  // ── source fetching ───────────────────────────────────────────────────────

  private async gatherCandidates(): Promise<Map<string, Candidate>> {
    const map = new Map<string, Candidate>();
    const [geckoNew, geckoTrending, boosts, profiles] = await Promise.all([
      this.fetchGeckoTerminalPools(GECKO_NEW_POOLS_URL, 'geckoterminal_new'),
      this.fetchGeckoTerminalPools(GECKO_TRENDING_URL, 'geckoterminal_trending'),
      this.fetchDexBoosts(),
      this.fetchDexProfiles(),
    ]);
    // GeckoTerminal first — provides richer fallback data when DexScreener batch misses an address
    for (const r of geckoNew) {
      if (!map.has(r.address)) map.set(r.address, { address: r.address, source: 'geckoterminal_new', geckoRaw: r });
    }
    for (const r of geckoTrending) {
      if (!map.has(r.address)) map.set(r.address, { address: r.address, source: 'geckoterminal_trending', geckoRaw: r });
    }
    for (const a of boosts) if (!map.has(a)) map.set(a, { address: a, source: 'dexscreener_boost' });
    for (const a of profiles) if (!map.has(a)) map.set(a, { address: a, source: 'dexscreener_profile' });
    this.logger.log(
      `Candidates: ${geckoNew.length} gecko-new, ${geckoTrending.length} gecko-trending, ` +
      `${boosts.length} dex-boosts, ${profiles.length} dex-profiles → ${map.size} unique`,
    );
    return map;
  }

  private async fetchGeckoTerminalPools(url: string, source: HotTokenSource): Promise<DexTokenData[]> {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(8_000),
        headers: { Accept: GECKO_ACCEPT },
      });
      if (!res.ok) {
        this.logger.warn(`GeckoTerminal (${source}) HTTP ${res.status}`);
        return [];
      }
      const json = await res.json();
      const pools: any[] = json.data ?? [];
      const included: any[] = json.included ?? [];

      const tokenById = new Map<string, { address: string; symbol: string; name: string }>();
      for (const inc of included) {
        if (inc.type === 'token' && inc.attributes?.address) {
          tokenById.set(inc.id as string, {
            address: inc.attributes.address as string,
            symbol: (inc.attributes.symbol as string) ?? '???',
            name: (inc.attributes.name as string) ?? 'Unknown',
          });
        }
      }

      const results: DexTokenData[] = [];
      for (const pool of pools.slice(0, 25)) {
        const baseTokenId = pool.relationships?.base_token?.data?.id as string | undefined;
        const token = baseTokenId ? tokenById.get(baseTokenId) : undefined;
        if (!token?.address) continue;

        const attrs = pool.attributes ?? {};
        const created = attrs.pool_created_at ? new Date(attrs.pool_created_at as string).getTime() : null;
        const pairAgeHours = created ? (Date.now() - created) / 3_600_000 : 999;
        const pct = (attrs.price_change_percentage as Record<string, string>) ?? {};
        const vol = (attrs.volume_usd as Record<string, string>) ?? {};

        results.push({
          address: token.address,
          symbol: token.symbol,
          name: token.name,
          priceUsd: parseFloat(attrs.base_token_price_usd as string ?? '0') || 0,
          priceChange5m: parseFloat(pct.m5 ?? '0') || 0,
          priceChange1h: parseFloat(pct.h1 ?? '0') || 0,
          priceChange24h: parseFloat(pct.h24 ?? '0') || 0,
          volume24hUsd: parseFloat(vol.h24 ?? '0') || 0,
          marketCapUsd: parseFloat((attrs.market_cap_usd ?? attrs.fdv_usd ?? '0') as string) || 0,
          liquidityUsd: parseFloat(attrs.reserve_in_usd as string ?? '0') || 0,
          pairAgeHours,
          dexUrl: `https://www.geckoterminal.com/solana/pools/${attrs.address as string}`,
          launchPlatform: 'geckoterminal',
        });
      }
      return results;
    } catch (err) {
      this.logger.warn(`GeckoTerminal (${source}) fetch skipped: ${(err as Error).message}`);
      return [];
    }
  }

  private async fetchDexBoosts(): Promise<string[]> {
    try {
      const res = await fetch(DEX_BOOSTS_URL, { signal: AbortSignal.timeout(6_000) });
      if (!res.ok) return [];
      const data = await res.json();
      return (Array.isArray(data) ? data : [])
        .filter((b: any) => b.chainId === 'solana' && b.tokenAddress)
        .map((b: any) => b.tokenAddress as string)
        .slice(0, 20);
    } catch { return []; }
  }

  private async fetchDexProfiles(): Promise<string[]> {
    try {
      const res = await fetch(DEX_PROFILES_URL, { signal: AbortSignal.timeout(6_000) });
      if (!res.ok) return [];
      const data = await res.json();
      return (Array.isArray(data) ? data : [])
        .filter((p: any) => p.chainId === 'solana' && p.tokenAddress)
        .map((p: any) => p.tokenAddress as string)
        .slice(0, 20);
    } catch { return []; }
  }

  // ── enrichment ────────────────────────────────────────────────────────────

  private async enrichCandidates(
    candidates: Map<string, Candidate>,
  ): Promise<Array<Candidate & { dex: DexTokenData | null }>> {
    const entries = [...candidates.values()];
    const results: Array<Candidate & { dex: DexTokenData | null }> = [];

    // Fan out pump.fun enrichment for all mints with the "pump" suffix in
    // parallel with the DexScreener batch loop. Provider has a 60s cache so
    // a token re-appearing in the next scan doesn't trigger another HTTP.
    const pumpMints = entries.map((e) => e.address).filter(isPumpFunMint);
    const pumpDataPromise = this.pumpFun && pumpMints.length
      ? this.pumpFun.getCoinDataBatch(pumpMints, 5).catch(() => new Map<string, PumpFunCoinData>())
      : Promise.resolve(new Map<string, PumpFunCoinData>());

    for (const chunk of this.chunk(entries, 10)) {
      const batch = await this.fetchDexBatch(chunk.map((e) => e.address));
      const byAddr = new Map(batch.map((d) => [d.address, d]));
      for (const entry of chunk) {
        // DexScreener is preferred; geckoRaw is used when DexScreener has no pair for this address
        const dex = byAddr.get(entry.address) ?? byAddr.get(entry.address.toLowerCase()) ?? entry.geckoRaw ?? null;
        results.push({ ...entry, dex });
      }
      if (entries.length > 10) await new Promise((r) => setTimeout(r, 150));
    }

    // Merge pump.fun data after the dex loop completes — non-blocking on the
    // hot path: if pump.fun is slow/down, we still return everything else.
    const pumpMap = await pumpDataPromise;
    if (pumpMap.size > 0) {
      for (const r of results) {
        const pf = pumpMap.get(r.address);
        if (pf) r.pumpFunData = pf;
      }
    }
    return results;
  }

  private async fetchDexBatch(addresses: string[]): Promise<DexTokenData[]> {
    if (!addresses.length) return [];
    try {
      const res = await fetch(`${DEX_TOKENS_URL}/${addresses.join(',')}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return [];
      const json = (await res.json()) as { pairs: any[] | null };
      const pairs = json.pairs ?? [];

      const best = new Map<string, any>();
      for (const pair of pairs) {
        const addr = pair.baseToken?.address as string | undefined;
        if (!addr) continue;
        const liq = (pair.liquidity?.usd as number) ?? 0;
        if (!best.has(addr) || liq > (best.get(addr).liquidity?.usd ?? 0)) best.set(addr, pair);
      }

      return addresses.flatMap((addr) => {
        const pair = best.get(addr) ?? best.get(addr.toLowerCase());
        if (!pair) return [];
        const created = pair.pairCreatedAt ? Number(pair.pairCreatedAt) : null;
        const pairAgeHours = created ? (Date.now() - created) / 3_600_000 : 999;
        return [{
          address: addr,
          symbol: pair.baseToken?.symbol ?? '???',
          name: pair.baseToken?.name ?? 'Unknown',
          priceUsd: Number(pair.priceUsd ?? 0),
          priceChange5m: pair.priceChange?.m5 ?? 0,
          priceChange1h: pair.priceChange?.h1 ?? 0,
          priceChange24h: pair.priceChange?.h24 ?? 0,
          volume24hUsd: pair.volume?.h24 ?? 0,
          marketCapUsd: pair.marketCap ?? pair.fdv ?? 0,
          liquidityUsd: pair.liquidity?.usd ?? 0,
          pairAgeHours,
          dexUrl: pair.url,
          launchPlatform: (pair.labels as string[] | undefined)?.includes('pump') ? 'pump.fun' : pair.dexId,
          buys1h: pair.txns?.h1?.buys,
          sells1h: pair.txns?.h1?.sells,
          buys5m: pair.txns?.m5?.buys,
          sells5m: pair.txns?.m5?.sells,
          volume1hUsd: pair.volume?.h1,
          volume5mUsd: pair.volume?.m5,
        } satisfies DexTokenData];
      });
    } catch { return []; }
  }

  // ── scoring ───────────────────────────────────────────────────────────────

  private scoreForProfile(
    enriched: Array<Candidate & { dex: DexTokenData | null }>,
    profileKey: TradingProfile,
    scannedAt: string,
  ): HotToken[] {
    const profile = getProfile(profileKey);
    const tokens: HotToken[] = [];

    for (const { address, source, dex, pumpFunData } of enriched) {
      let symbol = '???', name = 'Unknown', priceUsd = 0;
      let priceChange5m = 0, priceChange1h = 0, priceChange24h = 0;
      let volume24hUsd = 0, marketCapUsd = 0, liquidityUsd = 0;
      let pairAgeHours = 999, dexUrl: string | undefined, launchPlatform: string | undefined;
      let buys1h: number | undefined, sells1h: number | undefined, volume1hUsd: number | undefined;

      if (dex) {
        ({ symbol, name, priceUsd, priceChange5m, priceChange1h, priceChange24h,
          volume24hUsd, marketCapUsd, liquidityUsd, pairAgeHours, dexUrl, launchPlatform } = dex);
        ({ buys1h, sells1h, volume1hUsd } = dex);
        // Pump.fun fallbacks for pre-graduation tokens that DexScreener under-reports.
        if (pumpFunData) {
          if (!marketCapUsd && pumpFunData.marketCapUsd) marketCapUsd = pumpFunData.marketCapUsd;
          if (!symbol || symbol === '???') symbol = pumpFunData.symbol || symbol;
          if (!name || name === 'Unknown') name = pumpFunData.name || name;
          launchPlatform = launchPlatform ?? 'pump.fun';
        }
      } else if (pumpFunData) {
        // No DexScreener pool yet (still bonding) — pump.fun is authoritative.
        symbol = pumpFunData.symbol || '???';
        name = pumpFunData.name || 'Unknown';
        marketCapUsd = pumpFunData.marketCapUsd;
        priceUsd = marketCapUsd / 1e9;
        pairAgeHours = pumpFunData.createdAt
          ? (Date.now() - pumpFunData.createdAt) / 3_600_000
          : 0;
        launchPlatform = 'pump.fun';
      } else {
        continue;
      }

      const minLiq = profile.killOverrides.minLiquidityUsd;
      if (minLiq && liquidityUsd > 0 && liquidityUsd < minLiq) continue;
      const minAge = profile.killOverrides.minAgeHours;
      if (minAge && pairAgeHours < minAge) continue;
      const maxAge = profile.killOverrides.maxAgeHours;
      if (maxAge != null && pairAgeHours > maxAge) continue;

      const { score, verdict, summary } = computeHotTokenScore(
        {
          priceChange1h, priceChange5m, priceChange24h,
          volume24hUsd, liquidityUsd, marketCapUsd, pairAgeHours, source,
          buys1h, sells1h, volume1hUsd,
          bondingCurvePct:   pumpFunData?.bondingCurvePct,
          graduated:         pumpFunData?.graduated,
          isLive:            pumpFunData?.isLive,
          replyCount:        pumpFunData?.replyCount,
          athMarketCapUsd:   pumpFunData?.athMarketCapUsd,
        },
        profileKey,
      );

      tokens.push({
        address, symbol, name, chain: 'SOLANA',
        priceUsd, priceChange5m, priceChange1h, priceChange24h,
        volume24hUsd, marketCapUsd, liquidityUsd, pairAgeHours,
        source, launchPlatform, score, verdict, summary, dexUrl,
        profileKey, scannedAt,
        buys1h, sells1h, volume1hUsd,
      });
    }

    return tokens.sort((a, b) => b.score - a.score).slice(0, MAX_PER_PROFILE);
  }

  // ── Pump streak tracking ──────────────────────────────────────────────────

  private async processPumpStreaks(
    byProfile: Record<string, HotToken[]>,
    scannedAt: string,
  ): Promise<void> {
    try {
      // Collect best token data per address across all profiles.
      const best = new Map<string, HotToken>();
      for (const tokens of Object.values(byProfile)) {
        for (const t of tokens) {
          const prev = best.get(t.address);
          if (!prev || t.score > prev.score) best.set(t.address, t);
        }
      }

      const winners: PumpStreak[] = [];

      for (const t of best.values()) {
        const key = streakKey(t.address);
        let streak: { count: number; firstSeenAt: string; notified: boolean } = {
          count: 1, firstSeenAt: scannedAt, notified: false,
        };

        try {
          const raw = await this.redis.get(key);
          if (raw) {
            const prev = JSON.parse(raw);
            streak = { ...prev, count: (prev.count ?? 0) + 1 };
          }
        } catch { /* Redis miss is fine */ }

        await this.redis.setex(key, STREAK_TTL_SEC, JSON.stringify(streak))
          .catch((e: any) => this.logger.warn(`streak Redis write [${t.address.slice(0, 8)}]: ${e?.message}`));

        if (streak.count >= STREAK_THRESHOLD && !streak.notified) {
          // Mark notified so we only alert once per streak run
          streak.notified = true;
          await this.redis.setex(key, STREAK_TTL_SEC, JSON.stringify(streak))
            .catch((e: any) => this.logger.warn(`streak notify Redis write [${t.address.slice(0, 8)}]: ${e?.message}`));

          winners.push({
            address: t.address,
            symbol: t.symbol,
            priceUsd: t.priceUsd,
            priceChange1h: t.priceChange1h,
            score: t.score,
            count: streak.count,
            firstSeenAt: streak.firstSeenAt,
            profileKey: t.profileKey,
          });

          // Auto-capture to IntelSnapshot (minimal, no full AI report needed)
          if (this.intelSnapshots && t.priceUsd > 0) {
            this.intelSnapshots.captureMinimal({
              chain: 'SOLANA',
              address: t.address,
              source: 'hot_tokens_scan',
              priceUsdAtCapture: t.priceUsd,
              marketCapUsdAtCapture: t.marketCapUsd > 0 ? t.marketCapUsd : null,
              liquidityUsdAtCapture: t.liquidityUsd > 0 ? t.liquidityUsd : null,
              symbol: t.symbol,
              name: t.name,
            }).catch((e) => this.logger.warn(`streak capture failed: ${e?.message}`));
          }
        }
      }

      if (winners.length > 0) {
        this.logger.log(`Pump streaks hit threshold: ${winners.map((w) => w.symbol).join(', ')}`);
        this.realtime?.emitGlobal('pump_streak', { winners, scannedAt });
      }
    } catch (err) {
      this.logger.warn(`processPumpStreaks error: ${(err as Error).message}`);
    }
  }

  private chunk<T>(arr: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }
}
