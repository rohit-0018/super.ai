import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import IORedis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../ws/realtime.gateway';

const REFRESH_MINS = parseInt(process.env.TOKEN_POOL_REFRESH_MINS ?? '2', 10);
const STALE_HOURS = parseInt(process.env.TOKEN_STALE_HOURS ?? '24', 10);
const REFRESH_INTERVAL_MS = REFRESH_MINS * 60 * 1_000;
const DEX_TOKENS_URL = 'https://api.dexscreener.com/latest/dex/tokens';
const REDIS_KEY = 'qwai:pool:snapshot';
const REDIS_TTL_SEC = REFRESH_MINS * 60 * 4; // survive 4 refresh cycles

export interface PoolMeta {
  address: string;
  symbol: string | null;
  source: string;
  capturedAt: string;
  registeredAt: string;
  archived: boolean;
}

export interface PoolLiveData {
  priceUsd: number;
  marketCapUsd: number;
  priceChange1h: number;
  priceChange5m: number;
  volume24hUsd: number;
  liquidityUsd: number;
  lastRefreshed: string;
}

export type PoolEntry = PoolMeta & PoolLiveData;

export interface PoolSnapshot {
  entries: Record<string, PoolEntry>;
  refreshedAt: string;
  activeCount: number;
  archivedCount: number;
}

type InternalEntry = PoolMeta & Partial<PoolLiveData>;

@Injectable()
export class TokenPoolService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TokenPoolService.name);
  private readonly redis: IORedis;
  private readonly registry = new Map<string, InternalEntry>();
  private refreshTimer?: NodeJS.Timeout;
  private refreshing = false;

  constructor(
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly realtime?: RealtimeGateway,
  ) {
    this.redis = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      enableReadyCheck: false,
    });
    this.redis.on('error', () => {});
  }

  async onModuleInit() {
    await this.seedFromPrisma();
    await this.loadFromRedis();
    // Stagger first refresh to avoid hitting DexScreener right at startup
    setTimeout(() => {
      void this.refresh();
      this.refreshTimer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
    }, 30_000);
    this.logger.log(`Token pool ready: ${this.registry.size} tokens, refresh every ${REFRESH_MINS}m`);
  }

  onModuleDestroy() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.redis.quit().catch(() => {});
  }

  /**
   * Register a token address into the pool. No-op if already registered.
   * Called by HotTokensService on every scan so newly discovered tokens
   * are immediately included in the next pool refresh.
   */
  register(address: string, meta: { symbol?: string | null; source?: string; capturedAt?: string }) {
    if (!address || this.registry.has(address)) return;
    this.registry.set(address, {
      address,
      symbol: meta.symbol ?? null,
      source: meta.source ?? 'unknown',
      capturedAt: meta.capturedAt ?? new Date().toISOString(),
      registeredAt: new Date().toISOString(),
      archived: false,
    });
  }

  /** Returns the live entry for a single address, or null if unknown/archived. */
  getLive(address: string): (PoolMeta & Partial<PoolLiveData>) | null {
    const e = this.registry.get(address);
    return (e && !e.archived) ? e : null;
  }

  archiveAddress(address: string) {
    const e = this.registry.get(address);
    if (e) e.archived = true;
  }

  getSnapshot(): PoolSnapshot {
    const entries: Record<string, PoolEntry> = {};
    let activeCount = 0;
    let archivedCount = 0;
    for (const [addr, e] of this.registry) {
      if (e.archived) { archivedCount++; continue; }
      activeCount++;
      if (e.lastRefreshed) entries[addr] = e as PoolEntry;
    }
    return { entries, refreshedAt: new Date().toISOString(), activeCount, archivedCount };
  }

  async refresh() {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      // Re-seed so captures that arrived since last tick are included
      await this.seedFromPrisma();

      const now = Date.now();
      const staleMs = STALE_HOURS * 3_600_000;
      const active: string[] = [];
      const toArchive: string[] = [];

      for (const [addr, meta] of this.registry) {
        if (meta.archived) continue;
        if (now - new Date(meta.capturedAt).getTime() > staleMs) {
          meta.archived = true;
          toArchive.push(addr);
        } else {
          active.push(addr);
        }
      }

      if (!active.length && !toArchive.length) return;

      // Batch-fetch live prices — DexScreener accepts up to 30 per request
      const updates: Record<string, PoolLiveData> = {};
      const refreshedAt = new Date().toISOString();
      for (const chunk of this.chunk(active, 30)) {
        const batch = await this.fetchDexBatch(chunk);
        for (const d of batch) {
          const live: PoolLiveData = {
            priceUsd: d.priceUsd,
            marketCapUsd: d.marketCapUsd,
            priceChange1h: d.priceChange1h,
            priceChange5m: d.priceChange5m,
            volume24hUsd: d.volume24hUsd,
            liquidityUsd: d.liquidityUsd,
            lastRefreshed: refreshedAt,
          };
          updates[d.address] = live;
          const entry = this.registry.get(d.address);
          if (entry) Object.assign(entry, live);
        }
        if (active.length > 30) await new Promise((r) => setTimeout(r, 200));
      }

      await this.persistToRedis();

      if (Object.keys(updates).length > 0 || toArchive.length > 0) {
        this.realtime?.emitGlobal('pool_update', {
          updates,
          archivedAddresses: toArchive,
          refreshedAt,
        });
      }

      this.logger.log(
        `Pool refresh done: ${Object.keys(updates).length}/${active.length} updated, ${toArchive.length} archived`,
      );
    } catch (err) {
      this.logger.warn(`Pool refresh error: ${(err as Error).message}`);
    } finally {
      this.refreshing = false;
    }
  }

  // ── private helpers ─────────────────────────────────────────────────────────

  private async seedFromPrisma() {
    if (!this.prisma) return;
    try {
      const rows = await this.prisma.intelSnapshot.findMany({
        where: { status: { in: ['active', 'graduated'] as any } },
        select: { address: true, symbol: true, source: true, capturedAt: true },
      });
      for (const r of rows) {
        this.register(r.address, {
          symbol: r.symbol,
          source: r.source,
          capturedAt: r.capturedAt.toISOString(),
        });
      }
    } catch (err) {
      this.logger.warn(`Pool seed from Prisma failed: ${(err as Error).message}`);
    }
  }

  private async persistToRedis() {
    try {
      const snap = this.getSnapshot();
      await this.redis.setex(REDIS_KEY, REDIS_TTL_SEC, JSON.stringify(snap));
    } catch { /* non-critical */ }
  }

  private async loadFromRedis() {
    try {
      const raw = await this.redis.get(REDIS_KEY);
      if (!raw) return;
      const snap = JSON.parse(raw) as PoolSnapshot;
      for (const [addr, entry] of Object.entries(snap.entries)) {
        if (this.registry.has(addr)) {
          Object.assign(this.registry.get(addr)!, {
            priceUsd: entry.priceUsd,
            marketCapUsd: entry.marketCapUsd,
            priceChange1h: entry.priceChange1h,
            priceChange5m: entry.priceChange5m,
            volume24hUsd: entry.volume24hUsd,
            liquidityUsd: entry.liquidityUsd,
            lastRefreshed: entry.lastRefreshed,
          });
        } else {
          this.registry.set(addr, { ...entry });
        }
      }
      this.logger.log(`Loaded ${Object.keys(snap.entries).length} pool entries from Redis`);
    } catch { /* non-critical */ }
  }

  private async fetchDexBatch(addresses: string[]): Promise<Array<{
    address: string; priceUsd: number; marketCapUsd: number;
    priceChange1h: number; priceChange5m: number; volume24hUsd: number; liquidityUsd: number;
  }>> {
    try {
      const res = await fetch(`${DEX_TOKENS_URL}/${addresses.join(',')}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return [];
      const json = (await res.json()) as { pairs: any[] | null };
      const pairs = json.pairs ?? [];

      // Keep only the best (highest liquidity) pair per base token
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
        return [{
          address: addr,
          priceUsd: Number(pair.priceUsd ?? 0),
          priceChange1h: pair.priceChange?.h1 ?? 0,
          priceChange5m: pair.priceChange?.m5 ?? 0,
          volume24hUsd: pair.volume?.h24 ?? 0,
          marketCapUsd: pair.marketCap ?? pair.fdv ?? 0,
          liquidityUsd: pair.liquidity?.usd ?? 0,
        }];
      });
    } catch { return []; }
  }

  private chunk<T>(arr: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }
}
