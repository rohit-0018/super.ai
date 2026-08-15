import { Injectable, Logger, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * LiveTradeGuard — safety rails for users making LIVE (non-paper) trades.
 *
 * 1. Per-user swap rate limit: 10 swaps / rolling 60s window.
 * 2. Per-user withdraw rate limit: 5 withdraws / rolling 1h window.
 * 3. First-live-trade cap: a user's first 3 LIVE trades ever are capped at
 *    $100 USD notional each, giving them a gentle ramp from paper-mode habits
 *    before they can move size.
 *
 * Enforcement is in-memory (sliding windows) for rate limits + Prisma queries
 * for the cap. The cap query is cached 60s per user to keep hot paths cheap.
 */

interface Bucket { ts: number[]; }

const SWAP_WINDOW_MS = 60_000;
const SWAP_MAX = 10;
const WITHDRAW_WINDOW_MS = 3_600_000;
const WITHDRAW_MAX = 5;
const FIRST_LIVE_TRADE_CAP_USD = 100;
const FIRST_LIVE_TRADE_COUNT = 3;
const CAP_CACHE_TTL_MS = 60_000;

@Injectable()
export class LiveTradeGuardService {
  private readonly logger = new Logger(LiveTradeGuardService.name);
  private swapBuckets = new Map<string, Bucket>();
  private withdrawBuckets = new Map<string, Bucket>();
  private capCache = new Map<string, { liveTradesSoFar: number; cachedAt: number }>();

  constructor(private prisma: PrismaService) {}

  /**
   * Called from execution.service before a LIVE swap goes to the DEX.
   * Throws if the trade should be rejected.
   *
   * Side-aware enforcement:
   *   buy  → rate-limited (10 / 60s) + first-live-trade cap.
   *   sell → no rate limit, no cap. Users must always be able to exit a
   *          position; rate-limiting sells just traps them when liquidity
   *          is fleeing and they need to dump fast.
   */
  async checkLiveSwap(opts: { userId: string; notionalUsd: number; side?: 'buy' | 'sell' }): Promise<void> {
    if (opts.side === 'sell') return;

    this.hitRate(this.swapBuckets, opts.userId, SWAP_WINDOW_MS, SWAP_MAX, 'swap');

    const liveCount = await this.countLiveTrades(opts.userId);
    if (liveCount < FIRST_LIVE_TRADE_COUNT && opts.notionalUsd > FIRST_LIVE_TRADE_CAP_USD) {
      throw new BadRequestException({
        error: 'first_live_trade_cap',
        message:
          `First-live-trade cap: your first ${FIRST_LIVE_TRADE_COUNT} live trades are limited to ` +
          `$${FIRST_LIVE_TRADE_CAP_USD} each. You have ${liveCount}/${FIRST_LIVE_TRADE_COUNT} used. ` +
          `Try a smaller size, or switch to paper mode to practice.`,
        capUsd: FIRST_LIVE_TRADE_CAP_USD,
        remaining: FIRST_LIVE_TRADE_COUNT - liveCount,
      });
    }
  }

  /**
   * Called from wallets.service before executing a real withdrawal.
   */
  async checkLiveWithdraw(opts: { userId: string }): Promise<void> {
    this.hitRate(this.withdrawBuckets, opts.userId, WITHDRAW_WINDOW_MS, WITHDRAW_MAX, 'withdraw');
  }

  /** Invalidate cached live-trade count after a successful swap so cap tightens correctly. */
  invalidate(userId: string): void {
    this.capCache.delete(userId);
  }

  private hitRate(
    bucketMap: Map<string, Bucket>,
    userId: string,
    windowMs: number,
    limit: number,
    kind: 'swap' | 'withdraw',
  ) {
    const now = Date.now();
    const b = bucketMap.get(userId) ?? { ts: [] };
    // Prune old
    while (b.ts.length && b.ts[0] < now - windowMs) b.ts.shift();
    if (b.ts.length >= limit) {
      const waitSec = Math.ceil((b.ts[0] + windowMs - now) / 1000);
      this.logger.warn(
        `[rate-limit] user=${userId} kind=${kind} blocked (${b.ts.length}/${limit})`,
      );
      throw new ForbiddenException({
        error: 'rate_limit',
        message: `Too many ${kind}s. Try again in ${waitSec}s.`,
        kind,
        limit,
        windowSec: windowMs / 1000,
      });
    }
    b.ts.push(now);
    bucketMap.set(userId, b);
  }

  private async countLiveTrades(userId: string): Promise<number> {
    const cached = this.capCache.get(userId);
    if (cached && Date.now() - cached.cachedAt < CAP_CACHE_TTL_MS) {
      return cached.liveTradesSoFar;
    }
    const count = await this.prisma.trade.count({
      where: { userId, mode: 'LIVE' },
    });
    this.capCache.set(userId, { liveTradesSoFar: count, cachedAt: Date.now() });
    return count;
  }
}
