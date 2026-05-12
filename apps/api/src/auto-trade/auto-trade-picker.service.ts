import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { HotTokensService } from '../hot-tokens/hot-tokens.service';
import { AutoTradeService } from './auto-trade.service';

/**
 * Auto-trade picker. When `AutoPortfolio.autoEnabled = true` for a user,
 * this ticker reads the latest hot-tokens scan from in-memory cache (no
 * extra HTTP, no LLM, no Twitter cost) and opens auto-trade positions for
 * the top candidates that:
 *   - have a score >= portfolio.autoMinScore
 *   - aren't flagged with a hard dampener (paper-tape, thin-tape, post-ATH,
 *     dead curve) — those are exactly the "do not buy" signals our scorer
 *     surfaces
 *   - aren't already open for the same user
 *   - haven't been closed within the cooldown window
 *
 * Capped at `portfolio.maxConcurrent` open positions per user.
 */
const TICK_MS  = 5_000;
const DAMPENER_SUMMARY_TAGS = ['paper tape', 'thin tape', 'maybe wash', 'post-ATH', 'dead curve'];

@Injectable()
export class AutoTradePickerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AutoTradePickerService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly hotTokens: HotTokensService,
    private readonly autoTrade: AutoTradeService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    this.timer.unref();
    this.logger.log(`Auto-trade picker armed — tick every ${TICK_MS}ms`);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Single tick of the picker. Safe to call manually for tests. */
  async tick(): Promise<void> {
    if (this.running) return; // guard against overlap if a previous tick is slow
    this.running = true;
    try {
      const portfolios = await this.prisma.autoPortfolio.findMany({
        where: { autoEnabled: true },
      });
      if (!portfolios.length) return;

      for (const p of portfolios) {
        await this.pickForUser(p).catch((e) =>
          this.logger.warn(`pickForUser(${p.userId}) failed: ${(e as Error).message}`),
        );
      }
    } finally {
      this.running = false;
    }
  }

  private async pickForUser(portfolio: {
    userId: string;
    autoProfile: string;
    autoMinScore: number;
    positionSizeUsd: number;
    maxConcurrent: number;
    cooldownMinutes: number;
  }): Promise<void> {
    const scan = this.hotTokens.getLatest(portfolio.autoProfile);
    if (!scan || !scan.tokens.length) return;

    // Count open positions — hard ceiling on parallel exposure.
    const openCount = await this.prisma.autoPosition.count({ where: { userId: portfolio.userId } });
    const slots = portfolio.maxConcurrent - openCount;
    if (slots <= 0) return;

    // Build dedupe sets cheaply: open positions + recent closed trades.
    const [openAddrs, recentClosed] = await Promise.all([
      this.prisma.autoPosition.findMany({
        where: { userId: portfolio.userId },
        select: { tokenAddress: true },
      }),
      this.prisma.autoTrade.findMany({
        where: {
          userId: portfolio.userId,
          closedAt: { gt: new Date(Date.now() - portfolio.cooldownMinutes * 60_000) },
        },
        select: { tokenAddress: true },
      }),
    ]);
    const skip = new Set<string>([
      ...openAddrs.map((r) => r.tokenAddress),
      ...recentClosed.map((r) => r.tokenAddress),
    ]);

    // Pick the strongest qualifying tokens. tokens are already score-sorted
    // by scoreForProfile, so we just iterate top-down.
    let picked = 0;
    for (const t of scan.tokens) {
      if (picked >= slots) break;
      if (t.score < portfolio.autoMinScore) continue;
      if (skip.has(t.address)) continue;
      // skip if any hard-dampener tag landed in the summary
      const summaryLower = (t.summary ?? '').toLowerCase();
      if (DAMPENER_SUMMARY_TAGS.some((tag) => summaryLower.includes(tag))) continue;
      if (t.priceUsd <= 0) continue;

      const pos = await this.autoTrade.openPosition({
        userId:         portfolio.userId,
        tokenAddress:   t.address,
        symbol:         t.symbol,
        name:           t.name,
        chain:          t.chain as 'SOLANA' | 'EVM',
        profileKey:     portfolio.autoProfile,
        source:         'auto_picker',
        entryPriceUsd:  t.priceUsd,
        sizeUsd:        portfolio.positionSizeUsd,
        scoreAtEntry:   t.score,
        verdictAtEntry: t.verdict,
        scoreBreakdown: t.scoreBreakdown,
      }).catch((e) => {
        this.logger.warn(`openPosition failed ${t.symbol}: ${(e as Error).message}`);
        return null;
      });

      if (pos) {
        picked++;
        this.logger.log(`Auto-opened ${t.symbol} @ $${t.priceUsd.toExponential(2)} (score=${t.score}) for user=${portfolio.userId}`);
      }
    }
  }
}

