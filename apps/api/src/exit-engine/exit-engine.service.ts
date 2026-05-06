import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TokenPoolService } from '../hot-tokens/token-pool.service';
import { RealtimeGateway } from '../ws/realtime.gateway';
import { ExecutionService } from '../execution/execution.service';

// ── env config ────────────────────────────────────────────────────────────────
const ENABLED      = process.env.EXIT_ENGINE_ENABLED !== 'false';
const LIVE_MODE    = process.env.EXIT_ENGINE_LIVE    === 'true';
const TICK_MS      = parseInt(process.env.EXIT_ENGINE_TICK_MS   ?? '30000', 10);
const BATCH_SIZE   = parseInt(process.env.EXIT_ENGINE_BATCH     ?? '50',    10);

// Score drop below this threshold triggers thesis-break exit
const THESIS_BREAK_FLOOR     = parseInt(process.env.EXIT_THESIS_FLOOR     ?? '40', 10);
const THESIS_BREAK_DROP      = parseInt(process.env.EXIT_THESIS_DROP      ?? '20', 10);

// Time-stop thresholds
const TIME_STOP_48H_MOVE_PCT = parseFloat(process.env.EXIT_TIME_STOP_MOVE ?? '10') / 100; // <10% move
const TIME_STOP_48H_SELL_PCT = 50;
const TIME_STOP_72H_SELL_PCT = 100;

const SOL_MINT = 'So11111111111111111111111111111111111111112';

// ── Tier definitions per profile ──────────────────────────────────────────────

interface Tier {
  id:            string;
  mcapMultiple:  number;  // sell when currentMcap / entryMcap >= this
  sellPct:       number;  // % of ORIGINAL position to sell (not remaining)
  trailingStop:  number;  // trailing stop % to activate AFTER this tier fires
}

const PROFILE_TIERS: Record<string, Tier[]> = {
  degen_sniper: [
    { id: 'tier_0', mcapMultiple: 3,  sellPct: 35, trailingStop: 30 },
    { id: 'tier_1', mcapMultiple: 8,  sellPct: 30, trailingStop: 20 },
    { id: 'tier_2', mcapMultiple: 20, sellPct: 35, trailingStop: 12 },
  ],
  swing_trader: [
    { id: 'tier_0', mcapMultiple: 1.5, sellPct: 55, trailingStop: 20 },
    { id: 'tier_1', mcapMultiple: 3,   sellPct: 25, trailingStop: 15 },
    { id: 'tier_2', mcapMultiple: 6,   sellPct: 20, trailingStop: 12 },
  ],
  default: [
    { id: 'tier_0', mcapMultiple: 2,  sellPct: 50, trailingStop: 25 },
    { id: 'tier_1', mcapMultiple: 5,  sellPct: 25, trailingStop: 20 },
    { id: 'tier_2', mcapMultiple: 10, sellPct: 25, trailingStop: 15 },
  ],
};

// Trailing stop before any tier fires (loose — give position room to breathe)
const PRE_TIER_TRAILING_STOP_PCT = 30;

// ── Helper ────────────────────────────────────────────────────────────────────

function getTiers(profileKey?: string | null): Tier[] {
  return PROFILE_TIERS[profileKey ?? 'default'] ?? PROFILE_TIERS.default;
}

function tiersExecutedArr(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw as number[];
  return [];
}

/**
 * ExitEngineService — the core automated sell loop.
 *
 * Every TICK_MS (default 30 s) it loads all open buy trades, checks each
 * against staged take-profit tiers, trailing stop, time stop, and thesis-break
 * conditions, and executes paper (or live when EXIT_ENGINE_LIVE=true) sells
 * via ExecutionService.
 *
 * Paper trades fire by default; live trades require the explicit env flag.
 */
@Injectable()
export class ExitEngineService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExitEngineService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma:     PrismaService,
    private readonly pool:       TokenPoolService,
    private readonly realtime:   RealtimeGateway,
    @Optional() private readonly exec?: ExecutionService,
  ) {}

  onModuleInit() {
    if (!ENABLED) {
      this.logger.log('Exit engine DISABLED (EXIT_ENGINE_ENABLED=false)');
      return;
    }
    this.logger.log(
      `Exit engine started — tick=${TICK_MS}ms live=${LIVE_MODE} batchSize=${BATCH_SIZE}`,
    );
    // First tick after 10 s so other services have time to warm up
    setTimeout(() => void this.tick(), 10_000);
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // ── main loop ───────────────────────────────────────────────────────────────

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.processOpenTrades();
    } catch (err) {
      this.logger.error(`Exit engine tick failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async processOpenTrades(): Promise<void> {
    // Load open buy trades — no exitAt set yet.
    // In paper-only mode, restrict to PAPER. When live mode is on, process both.
    const where = LIVE_MODE
      ? { side: 'buy', exitAt: null }
      : { side: 'buy', exitAt: null, mode: 'PAPER' as const };

    const trades = await this.prisma.trade.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take: BATCH_SIZE,
      include: { user: { select: { id: true } } },
    });

    if (!trades.length) return;
    this.logger.debug(`Exit tick: evaluating ${trades.length} open trades`);

    for (const trade of trades) {
      await this.evaluateTrade(trade).catch((e: Error) =>
        this.logger.warn(`evaluateTrade ${trade.id}: ${e.message}`),
      );
    }
  }

  // ── per-trade evaluation ───────────────────────────────────────────────────

  private async evaluateTrade(trade: any): Promise<void> {
    const token = trade.tokenOut as string; // the bought token address

    // 1. Ensure token is in the pool so it receives live price updates
    this.pool.register(token, { source: 'exit_engine', capturedAt: trade.createdAt.toISOString() });

    // 2. Get current market cap
    const live = this.pool.getLive(token);
    if (!live?.marketCapUsd || live.marketCapUsd <= 0) return; // no data yet — skip this tick

    const currentMcap = live.marketCapUsd;

    // 3. Resolve entry mcap — stored on trade or fall back to DB sources
    let entryMcap = (trade.entryMcapUsd as number | null) ?? null;
    if (!entryMcap) {
      entryMcap = await this.resolveEntryMcap(trade.id, token, trade.createdAt as Date);
      if (!entryMcap) return; // can't evaluate without a baseline
    }

    const mcapRatio = currentMcap / entryMcap;

    // 4. Update highestMcapSeen + lastSignificantMoveAt
    const prevHigh   = (trade.highestMcapSeen as number | null) ?? entryMcap;
    const newHigh    = Math.max(prevHigh, currentMcap);
    const movedSig   = Math.abs(currentMcap - entryMcap) / entryMcap >= 0.10;
    const updateData: Record<string, unknown> = {
      entryMcapUsd:    entryMcap,
      highestMcapSeen: newHigh,
    };
    if (movedSig) updateData.lastSignificantMoveAt = new Date();

    await this.prisma.trade.update({ where: { id: trade.id }, data: updateData as any });

    // Reload refreshed data into local var
    const tiers        = getTiers(trade.strategyId ?? null);
    const executed     = tiersExecutedArr(trade.tiersExecuted);
    const entryUsd     = (trade.priceUsd as number | null) ?? 0;
    const openSec      = (Date.now() - (trade.createdAt as Date).getTime()) / 1000;
    const highestMcap  = newHigh;

    // 5. Staged take-profit tiers
    for (let i = 0; i < tiers.length; i++) {
      if (executed.includes(i)) continue; // already fired
      if (mcapRatio >= tiers[i].mcapMultiple) {
        const sellPct       = tiers[i].sellPct / 100;
        const sellNotional  = entryUsd * mcapRatio * sellPct;
        await this.executeSell(trade, live.priceUsd ?? 0, sellNotional, tiers[i].id);
        return; // one action per tick
      }
    }

    // 6. Trailing stop — activates once in profit (mcap > entry)
    if (mcapRatio > 1.0 && highestMcap > 0) {
      const trailingPct = this.resolveTrailingStop(executed, tiers);
      const stopLevel   = highestMcap * (1 - trailingPct / 100);
      if (currentMcap <= stopLevel) {
        const remainingPct  = this.remainingPositionPct(executed, tiers) / 100;
        const sellNotional  = entryUsd * mcapRatio * remainingPct;
        await this.executeSell(trade, live.priceUsd ?? 0, sellNotional, 'trailing_stop');
        return;
      }
    }

    // 7. Time stop
    const highestMovePct = (highestMcap - entryMcap) / entryMcap;
    if (openSec >= 72 * 3600 && highestMovePct < TIME_STOP_48H_MOVE_PCT) {
      const sellNotional = entryUsd * mcapRatio * (TIME_STOP_72H_SELL_PCT / 100);
      await this.executeSell(trade, live.priceUsd ?? 0, sellNotional, 'time_stop');
      return;
    }
    if (openSec >= 48 * 3600 && !executed.includes(0) && highestMovePct < TIME_STOP_48H_MOVE_PCT) {
      const sellNotional = entryUsd * mcapRatio * (TIME_STOP_48H_SELL_PCT / 100);
      await this.executeSell(trade, live.priceUsd ?? 0, sellNotional, 'time_stop');
      return;
    }

    // 8. Thesis-break (score degradation via VerdictHistory)
    await this.checkThesisBreak(trade, entryUsd, mcapRatio, live.priceUsd ?? 0);
  }

  // ── sell execution ─────────────────────────────────────────────────────────

  private async executeSell(
    trade: any,
    currentPriceUsd: number,
    sellNotionalUsd: number,
    reason: string,
  ): Promise<void> {
    if (sellNotionalUsd <= 0) return;

    const executed     = tiersExecutedArr(trade.tiersExecuted);
    const tiers        = getTiers(trade.strategyId ?? null);
    const tierIndex    = tiers.findIndex((t) => t.id === reason);
    const newExecuted  = tierIndex >= 0 ? [...executed, tierIndex] : executed;
    const allTiersDone = tiers.every((_, i) => newExecuted.includes(i));
    const isFullExit   = allTiersDone || reason === 'trailing_stop' || reason === 'time_stop' || reason === 'thesis_break';

    this.logger.log(
      `Exit: ${trade.tokenOut.slice(0, 8)}… reason=${reason} notional=$${sellNotionalUsd.toFixed(2)} fullExit=${isFullExit}`,
    );

    // Execute via ExecutionService (paper or live depending on trade.mode)
    let sellResult: { tradeId: string; txHash: string | null; amountOut: string } | null = null;
    if (this.exec) {
      try {
        // Find the wallet used for the original buy
        const wallet = await this.prisma.wallet.findFirst({
          where: { userId: trade.userId, chain: trade.chain },
          orderBy: { createdAt: 'asc' },
        });
        if (wallet) {
          // amountIn for sell = proportional token amount from the original amountOut
          const originalTokenAmt = parseFloat(trade.amountOut);
          const sellFraction     = Math.min(1, sellNotionalUsd / ((trade.priceUsd ?? sellNotionalUsd) * (currentPriceUsd || 1)));
          const sellTokenAmt     = Math.round(originalTokenAmt * sellFraction).toString();

          sellResult = await this.exec.swap({
            userId:      trade.userId,
            walletId:    wallet.id,
            chain:       trade.chain,
            tokenIn:     trade.tokenOut,  // selling the held token
            tokenOut:    SOL_MINT,        // receiving SOL
            amountIn:    sellTokenAmt,
            notionalUsd: sellNotionalUsd,
            slippageBps: 300,
            strategyId:  'exit_engine',
          });
        }
      } catch (err: any) {
        this.logger.warn(`Exit sell failed for trade=${trade.id}: ${err.message}`);
      }
    }

    // Update the trade record
    const entryUsd      = (trade.priceUsd as number | null) ?? 0;
    const gainUsd       = sellNotionalUsd - entryUsd * (sellNotionalUsd / (entryUsd || 1));
    const patchData: Record<string, unknown> = {
      tiersExecuted: newExecuted,
    };
    if (isFullExit) {
      patchData.exitReason     = reason;
      patchData.exitAt         = new Date();
      patchData.realizedPnl    = sellNotionalUsd - entryUsd; // simplified P&L
      patchData.holdDurationSec = Math.round((Date.now() - (trade.createdAt as Date).getTime()) / 1000);
    }
    await this.prisma.trade.update({ where: { id: trade.id }, data: patchData as any });

    // Emit WS event
    this.realtime.emitGlobal('trade_exit', {
      tradeId:         trade.id,
      sellTradeId:     sellResult?.tradeId ?? null,
      userId:          trade.userId,
      token:           trade.tokenOut,
      reason,
      sellNotionalUsd,
      gainUsd,
      isFullExit,
      txHash:          sellResult?.txHash ?? null,
      ts:              new Date().toISOString(),
    });

    this.realtime.emitToUser(trade.userId, 'trade_exit', {
      tradeId:         trade.id,
      token:           trade.tokenOut,
      reason,
      sellNotionalUsd: sellNotionalUsd.toFixed(2),
      isFullExit,
      ts:              new Date().toISOString(),
    });
  }

  // ── thesis-break detection ─────────────────────────────────────────────────

  private async checkThesisBreak(trade: any, entryUsd: number, mcapRatio: number, currentPrice: number): Promise<void> {
    const latest = await this.prisma.verdictHistory.findFirst({
      where: { address: trade.tokenOut },
      orderBy: { analyzedAt: 'desc' },
      select: { aiScore: true, aiVerdict: true },
    });
    if (!latest) return;

    const entryVerdict = await this.prisma.verdictHistory.findFirst({
      where: { address: trade.tokenOut, analyzedAt: { lte: trade.createdAt } },
      orderBy: { analyzedAt: 'desc' },
      select: { aiScore: true },
    });

    const entryScore   = entryVerdict?.aiScore ?? latest.aiScore;
    const scoreDrop    = entryScore - latest.aiScore;

    const honeypot     = latest.aiVerdict === 'HIGH_RISK';
    const scoreFailed  = latest.aiScore <= THESIS_BREAK_FLOOR && scoreDrop >= THESIS_BREAK_DROP;

    if (!honeypot && !scoreFailed) return;

    const reason      = honeypot ? 'thesis_break_honeypot' : 'thesis_break';
    const remaining   = this.remainingPositionPct(tiersExecutedArr(trade.tiersExecuted), getTiers(trade.strategyId)) / 100;
    const sellNotional = entryUsd * mcapRatio * remaining;

    this.logger.log(
      `Thesis break: ${trade.tokenOut.slice(0, 8)}… score=${latest.aiScore} drop=${scoreDrop} honeypot=${honeypot}`,
    );
    await this.executeSell(trade, currentPrice, sellNotional, reason);
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /** How much of the original position (%) has NOT been sold yet */
  private remainingPositionPct(executed: number[], tiers: Tier[]): number {
    const soldPct = executed.reduce((sum, idx) => sum + (tiers[idx]?.sellPct ?? 0), 0);
    return Math.max(0, 100 - soldPct);
  }

  /** Trailing stop % to apply given which tiers have already fired */
  private resolveTrailingStop(executed: number[], tiers: Tier[]): number {
    if (!executed.length) return PRE_TIER_TRAILING_STOP_PCT;
    const lastFired = Math.max(...executed);
    return tiers[lastFired]?.trailingStop ?? PRE_TIER_TRAILING_STOP_PCT;
  }

  /**
   * Resolves entry mcap from IntelSnapshot or VerdictHistory when the
   * Trade row doesn't have it set (pre-exit-engine trades).
   */
  private async resolveEntryMcap(tradeId: string, token: string, buyTime: Date): Promise<number | null> {
    // Try IntelSnapshot first
    const snap = await this.prisma.intelSnapshot.findUnique({
      where: { chain_address: { chain: 'SOLANA', address: token } },
      select: { marketCapUsdAtCapture: true },
    });
    if (snap?.marketCapUsdAtCapture && snap.marketCapUsdAtCapture > 0) {
      // Cache on the trade record so we don't query again
      await this.prisma.trade.update({
        where:  { id: tradeId },
        data:   { entryMcapUsd: snap.marketCapUsdAtCapture } as any,
      });
      return snap.marketCapUsdAtCapture;
    }

    // Fall back to VerdictHistory closest to buy time
    const vh = await this.prisma.verdictHistory.findFirst({
      where:   { address: token, analyzedAt: { lte: new Date(buyTime.getTime() + 600_000) } },
      orderBy: { analyzedAt: 'desc' },
      select:  { marketCapUsd: true },
    });
    if (vh?.marketCapUsd && vh.marketCapUsd > 0) {
      await this.prisma.trade.update({
        where: { id: tradeId },
        data:  { entryMcapUsd: vh.marketCapUsd } as any,
      });
      return vh.marketCapUsd;
    }

    return null;
  }
}
