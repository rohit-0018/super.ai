import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TokenPoolService } from '../hot-tokens/token-pool.service';
import { RealtimeGateway } from '../ws/realtime.gateway';
import { ExecutionService } from '../execution/execution.service';
import { HolderWatchService } from './holder-watch.service';
import { makeQueue, makeJobData, QUEUES } from '../agents/queues';
import {
  DEFAULT_EXIT_SIGNAL_CONFIG,
  pushWindow,
  realizedVolatilityPct,
  adaptiveTrailingPct,
  liquidityDrainTriggered,
  thinLiquidity,
  momentumReversal,
} from './exit-engine.signals';

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

// Sell reliability: how many failed attempts before a position is flagged stuck,
// and the base slippage that escalates with each consecutive failure.
const MAX_SELL_ATTEMPTS = parseInt(process.env.EXIT_MAX_SELL_ATTEMPTS ?? '5', 10);
const BASE_SLIPPAGE_BPS = parseInt(process.env.EXIT_BASE_SLIPPAGE_BPS ?? '300', 10);
const MAX_SLIPPAGE_BPS  = parseInt(process.env.EXIT_MAX_SLIPPAGE_BPS  ?? '2500', 10);

// Rolling mcap window length for the volatility estimate (ticks; ~30s each).
const VOL_WINDOW_CAP = parseInt(process.env.EXIT_VOL_WINDOW ?? '20', 10);

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

  // Pure-signal config + cheap in-memory rolling state (rebuilds within a few
  // ticks after a restart; pruned to active tokens each tick — see pruneState).
  private readonly sigCfg     = DEFAULT_EXIT_SIGNAL_CONFIG;
  private readonly mcapWindow = new Map<string, number[]>(); // token → recent mcap ticks
  private readonly peakLiq    = new Map<string, number>();   // token → highest liquidity seen

  constructor(
    @Optional() private readonly prisma:   PrismaService,
    @Optional() private readonly pool:     TokenPoolService,
    @Optional() private readonly realtime: RealtimeGateway,
    @Optional() private readonly exec?:    ExecutionService,
    @Optional() private readonly holderWatch?: HolderWatchService,
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
    if (!this.prisma) return;
    // Load open buy trades — no exitAt set yet, and not flagged stuck (a stuck
    // position has exhausted its retries and is awaiting manual intervention; we
    // stop auto-retrying it so we don't burn fees in a loop).
    // In paper-only mode, restrict to PAPER. When live mode is on, process both.
    const where = LIVE_MODE
      ? { side: 'buy', exitAt: null, sellStuck: false }
      : { side: 'buy', exitAt: null, sellStuck: false, mode: 'PAPER' as const };

    const trades = await this.prisma.trade.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take: BATCH_SIZE,
      include: { user: { select: { id: true } } },
    });

    if (!trades.length) return;
    this.logger.debug(`Exit tick: evaluating ${trades.length} open trades`);

    this.pruneState(new Set(trades.map((t) => t.tokenOut as string)));

    for (const trade of trades) {
      await this.evaluateTrade(trade).catch((e: Error) =>
        this.logger.warn(`evaluateTrade ${trade.id}: ${e.message}`),
      );
    }
  }

  /** Drop rolling state for tokens no longer in any open position (bounds memory). */
  private pruneState(activeTokens: Set<string>): void {
    for (const key of this.mcapWindow.keys()) if (!activeTokens.has(key)) this.mcapWindow.delete(key);
    for (const key of this.peakLiq.keys())    if (!activeTokens.has(key)) this.peakLiq.delete(key);
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

    const ctx = { mcapRatio, entryUsd, currentPriceUsd: live.priceUsd ?? 0 };
    const inProfit  = mcapRatio > 1.0;
    const remaining = () => this.remainingPositionPct(executed, tiers) / 100;

    // Maintain cheap in-memory rolling state from the tick we already have.
    const win = pushWindow(this.mcapWindow.get(token) ?? [], currentMcap, VOL_WINDOW_CAP);
    this.mcapWindow.set(token, win);
    const liqUsd  = (live.liquidityUsd as number | null) ?? 0;
    const peakLiq = Math.max(this.peakLiq.get(token) ?? 0, liqUsd);
    this.peakLiq.set(token, peakLiq);

    // 5a. DANGER — liquidity drain (LP pull / rug). Dump the remainder NOW,
    //     irrespective of P&L; getting out partially beats getting trapped.
    if (liqUsd > 0 && liquidityDrainTriggered(liqUsd, peakLiq, this.sigCfg)) {
      await this.executeSell(trade, { ...ctx, reason: 'liquidity_drain', sellFraction: remaining() });
      return;
    }

    // 5a.2 DANGER — whale/insider dump flagged by the (throttled) holder watcher.
    const dumpReason = this.holderWatch?.consumeSignal(token);
    if (dumpReason) {
      await this.executeSell(trade, { ...ctx, reason: dumpReason, sellFraction: remaining() });
      return;
    }

    // 5b. Staged take-profit tiers — sell a fraction of the ORIGINAL position
    for (let i = 0; i < tiers.length; i++) {
      if (executed.includes(i)) continue; // already fired
      if (mcapRatio >= tiers[i].mcapMultiple) {
        await this.executeSell(trade, { ...ctx, reason: tiers[i].id, sellFraction: tiers[i].sellPct / 100 });
        return; // one action per tick
      }
    }

    // 6. Volatility-adaptive trailing stop — activates once in profit; sells the
    //    remainder. The band widens with realized volatility (don't get noise-
    //    stopped), but thin liquidity forces the tightest band (exit fast before
    //    slippage eats the gains).
    if (inProfit && highestMcap > 0) {
      const baseTrail = this.resolveTrailingStop(executed, tiers);
      let trailingPct = adaptiveTrailingPct(baseTrail, realizedVolatilityPct(win), this.sigCfg);
      if (thinLiquidity(liqUsd, currentMcap, this.sigCfg)) trailingPct = this.sigCfg.minTrailingPct;
      const stopLevel = highestMcap * (1 - trailingPct / 100);
      if (currentMcap <= stopLevel) {
        await this.executeSell(trade, { ...ctx, reason: 'trailing_stop', sellFraction: remaining() });
        return;
      }
    }

    // 6b. Momentum reversal — a sharp 5m drop while in profit ("first red
    //     candle"); take the remainder rather than wait for the full trailing band.
    if (momentumReversal(live.priceChange5m as number | undefined, inProfit, this.sigCfg)) {
      await this.executeSell(trade, { ...ctx, reason: 'momentum_reversal', sellFraction: remaining() });
      return;
    }

    // 7. Time stop — flat positions get cut; sell the remainder still held
    const highestMovePct = (highestMcap - entryMcap) / entryMcap;
    if (openSec >= 72 * 3600 && highestMovePct < TIME_STOP_48H_MOVE_PCT) {
      const sellFraction = this.remainingPositionPct(executed, tiers) / 100;
      await this.executeSell(trade, { ...ctx, reason: 'time_stop', sellFraction });
      return;
    }
    if (openSec >= 48 * 3600 && !executed.includes(0) && highestMovePct < TIME_STOP_48H_MOVE_PCT) {
      await this.executeSell(trade, { ...ctx, reason: 'time_stop', sellFraction: TIME_STOP_48H_SELL_PCT / 100 });
      return;
    }

    // 8. Thesis-break (score degradation via VerdictHistory)
    await this.checkThesisBreak(trade, entryUsd, mcapRatio, live.priceUsd ?? 0);
  }

  // ── sell execution ─────────────────────────────────────────────────────────

  private async executeSell(
    trade: any,
    opts: { reason: string; sellFraction: number; mcapRatio: number; entryUsd: number; currentPriceUsd: number },
  ): Promise<void> {
    const { reason, mcapRatio, entryUsd, currentPriceUsd } = opts;
    const sellFraction = Math.min(1, Math.max(0, opts.sellFraction));
    if (sellFraction <= 0) return;

    // USD proceeds of selling `sellFraction` of the original position at the
    // current valuation. entryUsd bought the whole position; at mcapRatio the
    // whole position is worth entryUsd*mcapRatio, so the fraction yields:
    const sellNotionalUsd = entryUsd * mcapRatio * sellFraction;

    const executed     = tiersExecutedArr(trade.tiersExecuted);
    const tiers        = getTiers(trade.strategyId ?? null);
    const tierIndex    = tiers.findIndex((t) => t.id === reason);
    const newExecuted  = tierIndex >= 0 ? [...executed, tierIndex] : executed;
    const allTiersDone = tiers.every((_, i) => newExecuted.includes(i));
    const FULL_EXIT_REASONS = ['trailing_stop', 'time_stop', 'liquidity_drain', 'momentum_reversal', 'insider_dump'];
    const isFullExit   = allTiersDone || FULL_EXIT_REASONS.includes(reason) || reason.startsWith('thesis_break');

    this.logger.log(
      `Exit: ${trade.tokenOut.slice(0, 8)}… reason=${reason} frac=${(sellFraction * 100).toFixed(0)}% notional=$${sellNotionalUsd.toFixed(2)} fullExit=${isFullExit} attempt=${(trade.sellAttempts ?? 0) + 1}`,
    );

    // ── Attempt the swap. The trade is ONLY marked sold/exited if this returns. ──
    // ExecutionService.swap() resolves on a confirmed on-chain tx (live) or a
    // simulated fill (paper), and throws on any failure. We must never mutate
    // exit state on a throw, or we'd report a position as sold while the tokens
    // are still in the wallet.
    let sellResult: { tradeId: string; txHash: string | null; amountOut: string } | null = null;
    let failure: string | null = null;
    try {
      if (!this.exec) throw new Error('execution service unavailable');

      const wallet = await this.prisma.wallet.findFirst({
        where: { userId: trade.userId, chain: trade.chain },
        orderBy: { createdAt: 'asc' },
      });
      if (!wallet) throw new Error(`no ${trade.chain} wallet for user`);

      // Token amount to sell = the same fraction of the tokens originally received.
      const originalTokenAmt = parseFloat(trade.amountOut);
      if (!Number.isFinite(originalTokenAmt) || originalTokenAmt <= 0) throw new Error('original amountOut invalid');
      const sellTokenAmt = Math.max(1, Math.floor(originalTokenAmt * sellFraction)).toString();

      sellResult = await this.exec.swap({
        userId:      trade.userId,
        walletId:    wallet.id,
        chain:       trade.chain,
        tokenIn:     trade.tokenOut,  // selling the held token
        tokenOut:    SOL_MINT,        // receiving SOL
        amountIn:    sellTokenAmt,
        notionalUsd: sellNotionalUsd,
        slippageBps: this.slippageForAttempt(trade.sellAttempts ?? 0),
        strategyId:  'exit_engine',
      });
    } catch (err: any) {
      failure = err?.message ?? 'unknown error';
    }

    // ── Failure path: do NOT mark anything sold. Track the attempt and retry. ──
    if (!sellResult) {
      await this.recordSellFailure(trade, reason, failure ?? 'swap returned no result');
      return;
    }

    // ── Success path: the sale really happened — now it's safe to mutate state. ──
    const proceeds      = (trade.realizedProceedsUsd as number | null) ?? 0;
    const newProceeds   = proceeds + sellNotionalUsd;
    const patchData: Record<string, unknown> = {
      tiersExecuted:       newExecuted,
      realizedProceedsUsd: newProceeds,
      sellAttempts:        0,      // reset — this action landed
      lastSellError:       null,
    };
    if (isFullExit) {
      // realised P&L = everything we ever received from this position minus its cost
      const realizedPnl = newProceeds - entryUsd;
      patchData.exitReason      = reason;
      patchData.exitAt          = new Date();
      patchData.realizedPnl     = realizedPnl;
      patchData.pnlUsd          = realizedPnl; // learning worker reads pnlUsd
      patchData.holdDurationSec = Math.round((Date.now() - (trade.createdAt as Date).getTime()) / 1000);
    }
    await this.prisma.trade.update({ where: { id: trade.id }, data: patchData as any });

    // Fan out learning observation for the original buy trade now that outcome is known.
    // Gated inside the worker by LearningConfig.enabled — safe to always enqueue.
    if (isFullExit) {
      try {
        const q = makeQueue(QUEUES.LEARNING_INGEST);
        await q.add(
          'ingest',
          makeJobData({ userId: trade.userId, tradeId: trade.id }),
          { removeOnComplete: 500, removeOnFail: 100 },
        );
      } catch (e: any) {
        this.logger.warn(`Learning ingest enqueue failed for trade=${trade.id}: ${e.message}`);
      }
    }

    const gainUsd = sellNotionalUsd - entryUsd * sellFraction;
    this.realtime?.emitGlobal('trade_exit', {
      tradeId:         trade.id,
      sellTradeId:     sellResult.tradeId ?? null,
      userId:          trade.userId,
      token:           trade.tokenOut,
      reason,
      sellNotionalUsd,
      gainUsd,
      isFullExit,
      txHash:          sellResult.txHash ?? null,
      ts:              new Date().toISOString(),
    });

    this.realtime?.emitToUser(trade.userId, 'trade_exit', {
      tradeId:         trade.id,
      token:           trade.tokenOut,
      reason,
      sellNotionalUsd: sellNotionalUsd.toFixed(2),
      isFullExit,
      ts:              new Date().toISOString(),
    });
  }

  /** Slippage escalates with each consecutive failed attempt (300 → 600 → 1200 → … → cap). */
  private slippageForAttempt(attempts: number): number {
    return Math.min(MAX_SLIPPAGE_BPS, BASE_SLIPPAGE_BPS * Math.pow(2, Math.max(0, attempts)));
  }

  /**
   * Records a failed sell without touching exit state. Increments the attempt
   * counter; once attempts reach MAX_SELL_ATTEMPTS the position is flagged
   * `sellStuck` (auto-retry paused) and a high-severity alert is emitted so the
   * tokens are never silently stranded. The next tick retries with higher
   * slippage until then.
   */
  private async recordSellFailure(trade: any, reason: string, error: string): Promise<void> {
    const attempts = (trade.sellAttempts ?? 0) + 1;
    const stuck    = attempts >= MAX_SELL_ATTEMPTS;

    await this.prisma.trade.update({
      where: { id: trade.id },
      data:  { sellAttempts: attempts, lastSellError: error.slice(0, 500), sellStuck: stuck } as any,
    });

    if (stuck) {
      this.logger.error(
        `Sell STUCK after ${attempts} attempts: trade=${trade.id} token=${trade.tokenOut} reason=${reason} lastError=${error}`,
      );
    } else {
      this.logger.warn(`Exit sell failed (attempt ${attempts}/${MAX_SELL_ATTEMPTS}) trade=${trade.id}: ${error}`);
    }

    // Surface failures to the UI so a position never disappears silently.
    this.realtime?.emitToUser(trade.userId, 'trade_exit_failed', {
      tradeId:  trade.id,
      token:    trade.tokenOut,
      reason,
      error,
      attempts,
      stuck,
      ts:       new Date().toISOString(),
    });
    if (stuck) {
      this.realtime?.emitGlobal('sell_stuck', {
        tradeId: trade.id,
        userId:  trade.userId,
        token:   trade.tokenOut,
        reason,
        error,
        ts:      new Date().toISOString(),
      });
    }
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
    const sellFraction = this.remainingPositionPct(tiersExecutedArr(trade.tiersExecuted), getTiers(trade.strategyId)) / 100;

    this.logger.log(
      `Thesis break: ${trade.tokenOut.slice(0, 8)}… score=${latest.aiScore} drop=${scoreDrop} honeypot=${honeypot}`,
    );
    await this.executeSell(trade, { reason, sellFraction, mcapRatio, entryUsd, currentPriceUsd: currentPrice });
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
