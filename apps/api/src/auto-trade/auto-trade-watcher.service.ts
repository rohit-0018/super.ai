import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TokenPoolService } from '../hot-tokens/token-pool.service';
import { AutoTradeService } from './auto-trade.service';

/**
 * Price watcher for auto-trade open positions.
 *
 * Runs every ~3s regardless of whether auto-mode is on — open positions need
 * exits even after the user disables auto. Pulls live prices from:
 *   1) TokenPool snapshot (cheap, already maintained by hot-scan infra)
 *   2) Direct DexScreener batch fetch for any addresses missing/stale
 *
 * Decision making lives in AutoTradeService.decideExit so the close logic
 * stays testable and the watcher stays a thin orchestrator.
 */
const TICK_MS = 3_000;
const STALE_MS = 60_000;
const DEX_BATCH_URL = 'https://api.dexscreener.com/latest/dex/tokens';
const MAX_PER_BATCH = 30;

@Injectable()
export class AutoTradeWatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AutoTradeWatcherService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly pool: TokenPoolService,
    private readonly autoTrade: AutoTradeService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    this.timer.unref();
    this.logger.log(`Auto-trade watcher armed — tick every ${TICK_MS}ms`);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Single tick. Safe to call manually. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const positions = await this.prisma.autoPosition.findMany({});
      if (!positions.length) return;

      // Phase 1: gather prices from in-memory pool (cheap, ~no I/O).
      const snap = this.pool.getSnapshot();
      const now = Date.now();
      const liveByAddr = new Map<string, number>();
      const missing: string[] = [];

      for (const p of positions) {
        const entry = snap.entries[p.tokenAddress];
        const lastRefreshedAt = entry?.lastRefreshed ? new Date(entry.lastRefreshed).getTime() : 0;
        if (entry?.priceUsd && now - lastRefreshedAt < STALE_MS) {
          liveByAddr.set(p.tokenAddress, entry.priceUsd);
        } else {
          missing.push(p.tokenAddress);
        }
      }

      // Phase 2: batch-fetch missing prices from DexScreener (~1 HTTP/30 addrs).
      if (missing.length) {
        for (let i = 0; i < missing.length; i += MAX_PER_BATCH) {
          const chunk = missing.slice(i, i + MAX_PER_BATCH);
          const prices = await this.fetchDexPrices(chunk).catch(() => new Map<string, number>());
          for (const [a, px] of prices) liveByAddr.set(a, px);
        }
      }

      // Phase 3: update each position + close if exit fired.
      for (const p of positions) {
        const px = liveByAddr.get(p.tokenAddress);
        if (px == null || px <= 0) continue;
        try {
          const decision = await this.autoTrade.updatePriceTick(p, px);
          if (decision) {
            await this.autoTrade.closePosition(p.id, decision);
          }
        } catch (e: any) {
          this.logger.debug(`tick ${p.symbol ?? p.tokenAddress.slice(0, 6)}: ${e.message}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async fetchDexPrices(addresses: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!addresses.length) return out;
    try {
      const res = await fetch(`${DEX_BATCH_URL}/${addresses.join(',')}`, {
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return out;
      const json = (await res.json()) as { pairs: any[] | null };
      const pairs = json.pairs ?? [];
      // Pick highest-liquidity pair per token address.
      const best = new Map<string, any>();
      for (const pair of pairs) {
        const addr = pair?.baseToken?.address as string | undefined;
        if (!addr) continue;
        const liq = (pair.liquidity?.usd as number) ?? 0;
        const cur = best.get(addr);
        if (!cur || liq > (cur.liquidity?.usd ?? 0)) best.set(addr, pair);
      }
      for (const [addr, pair] of best) {
        const px = Number(pair.priceUsd ?? 0);
        if (px > 0) out.set(addr, px);
      }
    } catch (e: any) {
      this.logger.debug(`fetchDexPrices failed: ${e.message}`);
    }
    return out;
  }
}
