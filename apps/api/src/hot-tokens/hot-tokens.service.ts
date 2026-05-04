import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Optional } from '@nestjs/common';
import IORedis from 'ioredis';
import { RealtimeGateway } from '../ws/realtime.gateway';
import { TokenAnalysisService } from '../token-analysis/token-analysis.service';
import { IntelSnapshotService } from '../intel-track/intel-snapshot.service';
import { SignalPipelineService } from './signal-pipeline.service';
import { TokenPoolService } from './token-pool.service';
import { getProfile } from '../token-analysis/profile.config';
import { fmtPriceUsd } from '../common/format-price';
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

const SCAN_INTERVAL_MS = 60 * 1_000;
const REDIS_TTL_SEC = Math.ceil((SCAN_INTERVAL_MS * 3) / 1_000); // 3 min — survives two missed ticks
const MAX_PER_PROFILE = 12;
const ALL_PROFILES: TradingProfile[] = [
  'meme_hunter', 'degen_sniper', 'swing_trader', 'gem_hunt', 'alpha_hunt',
];

const PUMPFUN_URL = 'https://frontend-api.pump.fun/coins';
const DEX_BOOSTS_URL = 'https://api.dexscreener.com/token-boosts/latest/v1';
const DEX_PROFILES_URL = 'https://api.dexscreener.com/token-profiles/latest/v1';
const DEX_TOKENS_URL = 'https://api.dexscreener.com/latest/dex/tokens';

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
}

interface Candidate {
  address: string;
  source: HotTokenSource;
  pumpFunRaw?: Record<string, unknown>;
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
  private lastRedisErrorLog = 0;

  constructor(
    private readonly realtime: RealtimeGateway,
    private readonly tokenAnalysis: TokenAnalysisService,
    @Optional() private readonly intelSnapshots: IntelSnapshotService,
    @Optional() private readonly signalPipeline: SignalPipelineService,
    @Optional() private readonly tokenPool: TokenPoolService,
  ) {
    this.redis = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      enableReadyCheck: false,
    });
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
  }

  async onModuleDestroy() {
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
    if (!scan || !scan.tokens.length) return 'No hot tokens currently tracked.';
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

      this.realtime.emitGlobal('hot_tokens_update', {
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
      // Fire-and-forget — we don't await; a stagger avoids slamming provider rate limits.
      const uniqueAddrs = [...new Set(Object.values(byProfile).flat().map((t) => t.address))].slice(0, 8);
      this.prewarmAnalysis(uniqueAddrs);
    } catch (err) {
      this.logger.error(`Hot scan error: ${(err as Error).message}`);
    } finally {
      this.scanning = false;
    }
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
        this.realtime.emitGlobal('hot_tokens_refresh', {
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
    for (const address of addresses) {
      try {
        // analyzeAddress runs the full pipeline (market + safety + holders + social + smart-money + AI)
        // and persists to DB with a 12-min TTL. Subsequent clicks serve from that DB cache instantly.
        // Pass 'hot_tokens_scan' so the IntelSnapshot row is attributed correctly.
        await this.tokenAnalysis.analyzeAddress(address, false, 'hot_tokens_scan');
        this.logger.debug(`Pre-warmed analysis for ${address}`);
      } catch (err) {
        this.logger.debug(`Pre-warm skipped for ${address}: ${(err as Error).message}`);
      }
      // Stagger calls: 2.5s apart to avoid hammering provider rate limits.
      await new Promise((r) => setTimeout(r, 2_500));
    }
    this.logger.log(`Pre-warm complete for ${addresses.length} hot token addresses`);
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
    const [pf, boosts, profiles] = await Promise.all([
      this.fetchPumpFun(),
      this.fetchDexBoosts(),
      this.fetchDexProfiles(),
    ]);
    for (const r of pf) {
      const addr = r.mint as string;
      if (addr && !map.has(addr)) map.set(addr, { address: addr, source: 'pumpfun', pumpFunRaw: r });
    }
    for (const a of boosts) if (!map.has(a)) map.set(a, { address: a, source: 'dexscreener_boost' });
    for (const a of profiles) if (!map.has(a)) map.set(a, { address: a, source: 'dexscreener_profile' });
    this.logger.log(`Candidates: ${pf.length} pump.fun, ${boosts.length} dex-boosts, ${profiles.length} dex-profiles → ${map.size} unique`);
    return map;
  }

  private async fetchPumpFun(): Promise<Record<string, unknown>[]> {
    try {
      const res = await fetch(
        `${PUMPFUN_URL}?sort=last_trade_timestamp&order=DESC&limit=25&includeNsfw=false`,
        { signal: AbortSignal.timeout(8_000), headers: { Accept: 'application/json' } },
      );
      if (!res.ok) {
        this.logger.warn(`pump.fun HTTP ${res.status}`);
        return [];
      }
      const data = await res.json();
      if (!Array.isArray(data)) {
        this.logger.warn(`pump.fun unexpected shape: ${JSON.stringify(data).slice(0, 120)}`);
        return [];
      }
      return (data as Record<string, unknown>[]).slice(0, 25);
    } catch (err) {
      this.logger.warn(`pump.fun fetch skipped: ${(err as Error).message}`);
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
    for (const chunk of this.chunk(entries, 10)) {
      const batch = await this.fetchDexBatch(chunk.map((e) => e.address));
      const byAddr = new Map(batch.map((d) => [d.address, d]));
      for (const entry of chunk) results.push({ ...entry, dex: byAddr.get(entry.address) ?? null });
      if (entries.length > 10) await new Promise((r) => setTimeout(r, 150));
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

    for (const { address, source, dex, pumpFunRaw } of enriched) {
      let symbol = '???', name = 'Unknown', priceUsd = 0;
      let priceChange5m = 0, priceChange1h = 0, priceChange24h = 0;
      let volume24hUsd = 0, marketCapUsd = 0, liquidityUsd = 0;
      let pairAgeHours = 999, dexUrl: string | undefined, launchPlatform: string | undefined;

      if (dex) {
        ({ symbol, name, priceUsd, priceChange5m, priceChange1h, priceChange24h,
          volume24hUsd, marketCapUsd, liquidityUsd, pairAgeHours, dexUrl, launchPlatform } = dex);
      } else if (pumpFunRaw) {
        symbol = String(pumpFunRaw.symbol ?? '???');
        name = String(pumpFunRaw.name ?? 'Unknown');
        marketCapUsd = Number(pumpFunRaw.usd_market_cap ?? 0);
        priceUsd = marketCapUsd / 1e9;
        const created = pumpFunRaw.created_timestamp as number | undefined;
        pairAgeHours = created ? (Date.now() - created * 1_000) / 3_600_000 : 0;
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

      const { score, verdict, summary } = this.computeScore(
        { priceChange1h, priceChange5m, priceChange24h, volume24hUsd, liquidityUsd, pairAgeHours, source },
        profileKey,
      );

      tokens.push({
        address, symbol, name, chain: 'SOLANA',
        priceUsd, priceChange5m, priceChange1h, priceChange24h,
        volume24hUsd, marketCapUsd, liquidityUsd, pairAgeHours,
        source, launchPlatform, score, verdict, summary, dexUrl,
        profileKey, scannedAt,
      });
    }

    return tokens.sort((a, b) => b.score - a.score).slice(0, MAX_PER_PROFILE);
  }

  private computeScore(
    d: {
      priceChange1h: number; priceChange5m: number; priceChange24h: number;
      volume24hUsd: number; liquidityUsd: number; pairAgeHours: number;
      source: HotTokenSource;
    },
    profileKey: TradingProfile,
  ): { score: number; verdict: HotTokenVerdict; summary: string } {
    let score = 35;
    const pos: string[] = [];
    const neg: string[] = [];
    const { priceChange1h, priceChange5m, volume24hUsd, liquidityUsd, pairAgeHours, source } = d;
    const volLiq = liquidityUsd > 0 ? volume24hUsd / liquidityUsd : 0;

    if (priceChange1h > 100) { score += 22; pos.push(`+${priceChange1h.toFixed(0)}% 1h`); }
    else if (priceChange1h > 50) { score += 15; pos.push(`+${priceChange1h.toFixed(0)}% 1h`); }
    else if (priceChange1h > 20) { score += 9; pos.push(`+${priceChange1h.toFixed(0)}% 1h`); }
    else if (priceChange1h > 5) { score += 3; }
    else if (priceChange1h < -30) { score -= 12; neg.push(`${priceChange1h.toFixed(0)}% 1h`); }
    else if (priceChange1h < -15) { score -= 6; }

    if (priceChange5m > 15) { score += 10; pos.push(`+${priceChange5m.toFixed(0)}% 5m`); }
    else if (priceChange5m > 5) { score += 5; }
    else if (priceChange5m < -10) { score -= 5; }

    if (volLiq > 20) { score += 14; pos.push(`${volLiq.toFixed(0)}x vol/liq`); }
    else if (volLiq > 8) { score += 8; pos.push(`${volLiq.toFixed(0)}x vol/liq`); }
    else if (volLiq > 3) { score += 4; }
    else if (volLiq < 0.5 && liquidityUsd > 0) { score -= 5; }

    if (liquidityUsd >= 200_000) score += 7;
    else if (liquidityUsd >= 50_000) score += 3;
    else if (0 < liquidityUsd && liquidityUsd < 5_000) { score -= 8; neg.push('thin liq'); }

    if (profileKey === 'meme_hunter' || profileKey === 'degen_sniper') {
      if (pairAgeHours < 1) { score += 14; pos.push(`${(pairAgeHours * 60).toFixed(0)}m old`); }
      else if (pairAgeHours < 4) { score += 9; pos.push(`${pairAgeHours.toFixed(1)}h old`); }
      else if (pairAgeHours < 12) { score += 4; pos.push(`${pairAgeHours.toFixed(0)}h old`); }
      else if (pairAgeHours > 72) score -= 8;
      if (source === 'pumpfun') score += 5;
    } else if (profileKey === 'swing_trader') {
      if (pairAgeHours >= 6 && pairAgeHours <= 168) score += 5;
      else if (pairAgeHours < 6) { score -= 5; neg.push('too new'); }
    } else if (profileKey === 'gem_hunt') {
      if (pairAgeHours >= 72) score += 10;
      else { score -= 12; neg.push('too new'); }
    }

    const final = Math.max(0, Math.min(100, score));
    let verdict: HotTokenVerdict;
    if (final >= 78) verdict = 'STRONG_BUY';
    else if (final >= 62) verdict = 'BUY';
    else if (final >= 46) verdict = 'CAUTIOUS';
    else if (final >= 28) verdict = 'SKIP';
    else verdict = 'HIGH_RISK';

    const summary = [...pos.slice(0, 2), ...neg.slice(0, 1)].join(' · ') || 'on watch';
    return { score: final, verdict, summary };
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

        await this.redis.setex(key, STREAK_TTL_SEC, JSON.stringify(streak)).catch(() => {});

        if (streak.count >= STREAK_THRESHOLD && !streak.notified) {
          // Mark notified so we only alert once per streak run
          streak.notified = true;
          await this.redis.setex(key, STREAK_TTL_SEC, JSON.stringify(streak)).catch(() => {});

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
        this.realtime.emitGlobal('pump_streak', { winners, scannedAt });
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
