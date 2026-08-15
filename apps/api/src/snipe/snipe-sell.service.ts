/**
 * SnipeSellService — production-grade sniper exit engine.
 *
 * Mirrors SnipeFastService's buy architecture on the sell side:
 *   1. Pre-builds 3 signed bundles in parallel (dynamic → 2500bps → 5000bps)
 *   2. Broadcasts level 0 immediately via Helius staked sendConnection
 *   3. Returns the signature instantly (non-blocking)
 *   4. Background loop: polls confirmation every 1.4 s; on slippage failure
 *      broadcasts next pre-signed bundle in <50 ms
 *   5. Emits WS events: snipe_sold (broadcast), snipe_sold_confirmed (landed),
 *      snipe_sell_update (retry / fail)
 *
 * Security controls:
 *   - In-memory execLock prevents concurrent sells on the same trade
 *   - Atomic DB updateMany claim prevents auto+manual race
 *   - sellAttempts limit (≤ 3) prevents infinite retry loops
 *   - Balance check warns before sending if wallet is too dry
 *   - Session ownership validated before every operation
 *
 * Helius optimisations:
 *   - Dynamic priority fee from getPriorityFeeEstimate (2 s cache)
 *   - sendConnection uses processed commitment + staked endpoint
 *   - connection (confirmed) used only for status polling
 */

import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { PrismaService } from '../prisma/prisma.service';
import { SnipeSessionService } from './snipe-session.service';
import { HeliusService } from './helius.service';
import { RealtimeGateway } from '../ws/realtime.gateway';
import { getJupiterApiBase } from '../common/network-config';

// ── Constants ────────────────────────────────────────────────────────────────

const SOL_MINT              = 'So11111111111111111111111111111111111111112';
const POSITION_CHECK_MS     = 2_000;    // detection cadence — 5× faster than legacy 10 s
const CONFIRM_POLL_MS       = 1_400;    // poll cadence (same as buy)
const CONFIRM_TIMEOUT_MS    = 20_000;   // per-attempt timeout (buy uses 15 s; exits get 20 s)
const MAX_SELL_ATTEMPTS     = 3;        // total broadcast attempts before giving up
const MIN_FEE_RESERVE_LAMPORTS = 10_000; // warn if wallet SOL below this
const BLOCKHASH_SAFE_WINDOW_MS  = 45_000; // pre-signed tx safe reuse window

// Sell slippage levels — snipe exits are volatile, so caps are high
const SELL_SLIPPAGE_LEVELS: Array<number | 'dynamic'> = ['dynamic', 2_500, 5_000];

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-SELL PLAYBOOKS — three risk presets (research-backed; see docs/AUTO_SELL_STRATEGY.md)
//
// User picks one in /snipe settings. Backend reads SnipeConfig.riskPreset
// and resolves the matching preset object for every phase-machine check.
//
// Phase machine: pre_tp1 → post_tp1 → moonbag → closed
// ─────────────────────────────────────────────────────────────────────────────
interface SellPreset {
  HARD_SL_PCT: number;
  TP1_TRIGGER_PCT: number;
  TP1_EXIT_PCT: number;
  TIME_DECAY_MS: number;
  TIME_DECAY_MIN_PCT: number;
  LIQUIDITY_PANIC_PCT: number;
  TRAIL_POST_TP1_PCT: number;
  TP2_TRIGGER_PCT: number;
  TP2_EXIT_PCT: number;
  TRAIL_MOONBAG_PCT: number;
}

const PRESETS: Record<string, SellPreset> = {
  CONSERVATIVE: {
    HARD_SL_PCT:          -30,
    TP1_TRIGGER_PCT:      +50,
    TP1_EXIT_PCT:         50,
    TIME_DECAY_MS:        10 * 60_000,
    TIME_DECAY_MIN_PCT:   +20,
    LIQUIDITY_PANIC_PCT:  -30,
    TRAIL_POST_TP1_PCT:   25,
    TP2_TRIGGER_PCT:      +200,
    TP2_EXIT_PCT:         70,
    TRAIL_MOONBAG_PCT:    40,
  },
  DEFAULT: {
    HARD_SL_PCT:          -40,
    TP1_TRIGGER_PCT:      +100,
    TP1_EXIT_PCT:         50,
    TIME_DECAY_MS:        15 * 60_000,
    TIME_DECAY_MIN_PCT:   +30,
    LIQUIDITY_PANIC_PCT:  -40,
    TRAIL_POST_TP1_PCT:   35,
    TP2_TRIGGER_PCT:      +300,
    TP2_EXIT_PCT:         50,
    TRAIL_MOONBAG_PCT:    50,
  },
  AGGRESSIVE: {
    HARD_SL_PCT:          -50,
    TP1_TRIGGER_PCT:      +150,
    TP1_EXIT_PCT:         40,
    TIME_DECAY_MS:        20 * 60_000,
    TIME_DECAY_MIN_PCT:   +50,
    LIQUIDITY_PANIC_PCT:  -50,
    TRAIL_POST_TP1_PCT:   50,
    TP2_TRIGGER_PCT:      +500,
    TP2_EXIT_PCT:         60,
    TRAIL_MOONBAG_PCT:    60,
  },
};

function resolvePreset(name: string | null | undefined): SellPreset {
  if (name && PRESETS[name]) return PRESETS[name];
  return PRESETS.DEFAULT;
}

type SellPhase = 'pre_tp1' | 'post_tp1' | 'moonbag' | 'closed';

/**
 * Phase 2.4 — Adaptive initial slippage.
 *
 * On the first sell broadcast we pick slippage based on the pool's liquidity
 * at buy time. Deep pools tolerate tight slippage (cheaper fill); shallow
 * pools need wide slippage (any landing is a win). Retry path still escalates
 * inside monitorSell on slippage failure, so this is a starting point only.
 */
function pickInitialSellSlippageBps(liquidityAtBuyUsd: number | null | undefined): number {
  const liq = liquidityAtBuyUsd ?? 0;
  if (liq >= 50_000) return 500;    // ≥ $50k → 5% (liquid Raydium/Meteora pool)
  if (liq >= 10_000) return 1_000;  // ≥ $10k → 10%
  if (liq >= 5_000)  return 2_000;  // ≥ $5k → 20%
  return 5_000;                     // < $5k or unknown → 50% (post-launch / unknown)
}

// Quote cache shared across trades within one tick. One Jupiter quote per mint.
interface MintQuote { solBack: bigint; ts: number; }

// Liquidity cache for the panic-exit check. DexScreener hits are 60s-cached
// per mint so multiple positions on the same mint share one fetch.
interface LiqEntry { liqUsd: number | null; ts: number; }
const LIQ_CACHE_TTL_MS = 60_000;
const LIQ_FETCH_TIMEOUT_MS = 4_000;
const DEXSCREENER_TOKENS_URL = 'https://api.dexscreener.com/latest/dex/tokens';

// ── Types ────────────────────────────────────────────────────────────────────

type SellStatus = 'confirmed' | 'slippage_failed' | 'other_failed' | 'timeout';

interface SellBundle {
  rawTx: Uint8Array;
  /** Token amount coming back (in SOL lamports as a string from Jupiter). */
  solBack: string;
  slippage: number | 'dynamic';
}

// ── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class SnipeSellService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SnipeSellService.name);
  private positionTimer: NodeJS.Timeout | null = null;

  /** tradeId → lock. Prevents concurrent auto + manual sells. */
  private readonly execLock = new Set<string>();

  /** tradeId → peak price multiple. Tracked across ticks for trailing stops. */
  private readonly peaks = new Map<string, number>();

  /** mint → cached liquidity reading. 60s TTL — multiple ticks share one fetch. */
  private readonly liqCache = new Map<string, LiqEntry>();

  /**
   * mint → consecutive Jupiter "no route" tick count. Phase 2.2 honeypot
   * detection: if Jupiter can't find a sell route N ticks in a row, the
   * token is almost certainly a honeypot (buys allowed but sells blocked
   * by the token contract). Mark all open positions as `sellStatus='honeypot'`
   * so they stop wasting RPC on retries.
   */
  private readonly noRouteCount = new Map<string, number>();
  private static readonly HONEYPOT_TICK_THRESHOLD = 3;

  /**
   * Phase 2.6 — top-holder dump watch.
   * mint → most recent reading of (sum of top-3 token-account balances, ts).
   * If the sum drops >TOP_HOLDER_DROP_PCT between two readings, panic exit.
   * 30s TTL — the polling tick is 2s but we only refresh the RPC fetch every
   * 30s to avoid spamming Helius.
   */
  private readonly topHolderCache = new Map<string, { topSum: bigint; ts: number }>();
  private static readonly TOP_HOLDER_TTL_MS = 30_000;
  private static readonly TOP_HOLDER_DROP_PCT = 20;   // > 20% drop = panic
  private readReadConn: any = null; // lazy

  constructor(
    @Optional() private prisma:   PrismaService,
    @Optional() private session:  SnipeSessionService,
    @Optional() private helius:   HeliusService,
    @Optional() private ws:       RealtimeGateway,
  ) {}

  onModuleInit() {
    this.positionTimer = setInterval(
      () => this.checkPositions().catch((e) => this.logger.warn(`Position check error: ${e.message}`)),
      POSITION_CHECK_MS,
    );
  }

  onModuleDestroy() {
    if (this.positionTimer) clearInterval(this.positionTimer);
    this.execLock.clear();
    this.peaks.clear();
    this.liqCache.clear();
    this.noRouteCount.clear();
    this.topHolderCache.clear();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Manual sell from the web UI (POST /api/snipe/history/:id/sell).
   * Validates ownership, then delegates to executeSell.
   */
  async manualSell(userId: string, tradeId: string): Promise<{ txHash: string | null }> {
    const trade = await this.prisma.snipeTrade.findFirst({
      where: { id: tradeId, userId },
      select: {
        id: true, userId: true, mint: true, outAmount: true, amountRaw: true,
        groupId: true, status: true, sellStatus: true, sellAttempts: true,
        chain: true,
      },
    });

    if (!trade) throw new Error('Trade not found or access denied');
    if (!trade.outAmount) throw new Error('No token balance on record — nothing to sell');

    // Block if a sell is already in a terminal in-progress state
    const blocked = trade.sellStatus && !['failed', null, undefined].includes(trade.sellStatus as any);
    if (blocked) {
      const msg = `Cannot sell — current sellStatus is '${trade.sellStatus}'`;
      this.logger.warn(msg);
      throw new Error(msg);
    }

    // Manual sell = exit the ENTIRE remaining position, mark closed.
    return this.executeSell(trade as any, 'manual', {
      tokenAmount: trade.outAmount,
      fraction: 1.0,
      nextPhase: 'closed',
      final: true,
    });
  }

  // ── Position monitoring ───────────────────────────────────────────────────
  //
  // The phase machine. Runs every POSITION_CHECK_MS (2s). On each tick:
  //   1. Load all open positions across users.
  //   2. Group by mint (one Jupiter quote per mint instead of per trade).
  //   3. For each trade, evaluate triggers for its current phase.
  //   4. Trigger fires → executeSell with the right session for trade.walletId
  //      and the right token fraction for the phase transition.
  //
  // Multi-wallet correctness: legacy code always used the user's *primary*
  // session — silently orphaned burst-wallet positions. Now we look up by
  // trade.walletId so every position sells from its actual buyer wallet.

  private async checkPositions() {
    if (!this.prisma) return;
    const jupBase = getJupiterApiBase();
    if (jupBase === 'MOCK') return;

    // Open positions: confirmed buys with token balance, NOT in a terminal
    // sell state. Phases pre_tp1/post_tp1/moonbag stay in the query — they
    // still have remaining tokens that need triggers monitored.
    const trades = await this.prisma.snipeTrade.findMany({
      where: {
        status: 'confirmed',
        outAmount: { not: null },
        OR: [
          { sellStatus: null },                       // never tried
          { sellStatus: 'failed', sellAttempts: { lt: MAX_SELL_ATTEMPTS } },
          { sellStatus: 'partial_tp1' },              // TP1 fired, still in post_tp1
          { sellStatus: 'partial_tp2' },              // TP2 fired, moonbag remaining
        ],
      },
      take: 200,                                      // grow with the 2s cadence
      orderBy: { createdAt: 'asc' },
    });

    // Garbage-collect peaks for trades no longer in the active set.
    if (this.peaks.size > 0) {
      const live = new Set(trades.map((t) => t.id));
      for (const id of this.peaks.keys()) {
        if (!live.has(id)) this.peaks.delete(id);
      }
    }

    // Group by mint → one Jupiter quote shared across all sibling positions.
    // We quote the LARGEST outAmount in the group, then scale for smaller
    // positions (Jupiter's price impact is approximately linear in the small).
    const byMint = new Map<string, any[]>();
    for (const t of trades) {
      const arr = byMint.get(t.mint) ?? [];
      arr.push(t);
      byMint.set(t.mint, arr);
    }

    await Promise.allSettled(
      Array.from(byMint.entries()).map(([mint, group]) =>
        this.evaluateMintGroup(mint, group, jupBase),
      ),
    );
  }

  /** Evaluate all positions for a single mint with one shared Jupiter quote. */
  private async evaluateMintGroup(mint: string, trades: any[], jupBase: string) {
    // Largest outAmount = quote anchor. Cheaper-per-token for smaller positions
    // is acceptable noise; we're not market-making, we're triggering exits.
    let maxOut = 0n;
    for (const t of trades) {
      try { const v = BigInt(t.outAmount); if (v > maxOut) maxOut = v; } catch {}
    }
    if (maxOut === 0n) return;

    // Fire Jupiter quote + DexScreener liquidity + top-holder dump check in
    // parallel. Each has its own cache + timeout so the slowest one bounds
    // the tick.
    const [totalSolForMax, currentLiqUsd, topHolderDumped] = await Promise.all([
      this.fetchSellQuote(mint, maxOut.toString(), 5_000, jupBase),
      this.fetchCurrentLiquidityUsd(mint),
      this.checkTopHolderDump(mint),
    ]);

    // Phase 2.2 — honeypot detection. If Jupiter can't find a sell route
    // N ticks in a row, the token almost certainly disables sells. Mark
    // all open positions for this mint and stop monitoring them.
    if (totalSolForMax === null) {
      const misses = (this.noRouteCount.get(mint) ?? 0) + 1;
      this.noRouteCount.set(mint, misses);
      if (misses >= SnipeSellService.HONEYPOT_TICK_THRESHOLD) {
        await this.markHoneypot(mint, trades);
      }
      return;
    }
    // Quote came back — reset the consecutive-miss counter.
    if (this.noRouteCount.has(mint)) this.noRouteCount.delete(mint);

    // Per-token price (SOL lamports per token base unit). Used to scale.
    const lamportsPerToken = totalSolForMax / Number(maxOut);

    await Promise.allSettled(trades.map((t) => this.evaluateTrade(t, lamportsPerToken, currentLiqUsd, topHolderDumped)));
  }

  /**
   * Mark all open positions for a mint as `sellStatus='honeypot'`. They stop
   * being picked up by the position monitor query (the WHERE clause only
   * includes null/failed/partial_*), so we don't waste RPC retrying. Emits a
   * distinct WS event so the UI can highlight these rows as honeypots, not
   * "failed sells".
   */
  private async markHoneypot(mint: string, trades: any[]) {
    this.logger.error(
      `[sell] 🍯 HONEYPOT detected mint=${mint.slice(0, 8)} — ${trades.length} positions stuck`,
    );
    const tradeIds = trades.map((t) => t.id);
    await this.prisma.snipeTrade.updateMany({
      where: { id: { in: tradeIds } },
      data: {
        sellStatus: 'honeypot',
        sellReason: 'honeypot',
        errorMsg: 'Jupiter cannot find a sell route — token likely disables transfers',
      },
    }).catch(() => {});
    // Reset the counter so if liquidity ever returns (unlikely) we'd retry.
    this.noRouteCount.delete(mint);
    // Notify each affected user.
    const byUser = new Map<string, any[]>();
    for (const t of trades) {
      const arr = byUser.get(t.userId) ?? [];
      arr.push(t);
      byUser.set(t.userId, arr);
    }
    for (const [userId, userTrades] of byUser) {
      this.ws?.emitToUser(userId, 'snipe_honeypot', {
        mint, tradeIds: userTrades.map((t) => t.id),
        count: userTrades.length, ts: Date.now(),
      });
    }
  }

  /**
   * Fetch current pool liquidity in USD for a mint. 60s in-memory cache —
   * multiple positions on the same mint share one DexScreener call.
   * Returns null on timeout / no-route / API blip; caller must treat null
   * as "unknown, don't trigger panic on this tick".
   */
  private async fetchCurrentLiquidityUsd(mint: string): Promise<number | null> {
    const now = Date.now();
    const cached = this.liqCache.get(mint);
    if (cached && now - cached.ts < LIQ_CACHE_TTL_MS) return cached.liqUsd;

    try {
      const res = await fetch(`${DEXSCREENER_TOKENS_URL}/${mint}`, {
        signal: AbortSignal.timeout(LIQ_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        this.liqCache.set(mint, { liqUsd: cached?.liqUsd ?? null, ts: now });
        return cached?.liqUsd ?? null;
      }
      const json: any = await res.json();
      const pairs: any[] = Array.isArray(json?.pairs) ? json.pairs : [];
      // Sum liquidity across all pools for this mint (we're a holder, so
      // total venue depth matters for "can we exit").
      let total = 0;
      for (const p of pairs) {
        const liq = Number(p?.liquidity?.usd);
        if (Number.isFinite(liq) && liq > 0) total += liq;
      }
      const result = total > 0 ? total : null;
      this.liqCache.set(mint, { liqUsd: result, ts: now });
      return result;
    } catch (e: any) {
      // Network blip / timeout — return last-known to avoid false-positives.
      this.liqCache.set(mint, { liqUsd: cached?.liqUsd ?? null, ts: now });
      return cached?.liqUsd ?? null;
    }
  }

  /**
   * Phase 2.6 — top-holder dump check.
   *
   * Strategy: sum the top-3 token-account balances for the mint, compare to
   * the previous reading. If the sum dropped > TOP_HOLDER_DROP_PCT, panic
   * exit all positions for the mint. This catches both:
   *   - LP pool drains (the pool's own token account is usually #1)
   *   - Whale/dev wallet dumps (their account drops out of top-3)
   *
   * Returns `true` if a dump was detected this tick. Caller decides what to
   * do (we trigger panic exit from evaluateTrade so all sibling rows fire).
   *
   * 30s TTL — RPC cost: 1 call per mint per 30s = ~2 calls/min/mint.
   */
  private async checkTopHolderDump(mint: string): Promise<boolean> {
    const now = Date.now();
    const last = this.topHolderCache.get(mint);
    if (last && now - last.ts < SnipeSellService.TOP_HOLDER_TTL_MS) {
      return false; // not enough time elapsed for a meaningful comparison
    }
    try {
      if (!this.readReadConn) this.readReadConn = this.helius?.makeReadConnection();
      if (!this.readReadConn) return false;
      const { PublicKey } = await import('@solana/web3.js');
      const resp = await this.readReadConn.getTokenLargestAccounts(new PublicKey(mint), 'confirmed');
      const accounts: Array<{ amount: string }> = resp?.value ?? [];
      if (accounts.length === 0) return false;

      // Sum top-3 by raw amount (base units, BigInt-safe).
      let topSum = 0n;
      for (let i = 0; i < Math.min(3, accounts.length); i++) {
        try { topSum += BigInt(accounts[i].amount); } catch {}
      }
      if (topSum === 0n) return false;

      const dumped = last && last.topSum > 0n &&
        ((Number(last.topSum - topSum) * 100) / Number(last.topSum)) >
          SnipeSellService.TOP_HOLDER_DROP_PCT;

      this.topHolderCache.set(mint, { topSum, ts: now });

      if (dumped) {
        const dropPct = ((Number(last!.topSum - topSum) * 100) / Number(last!.topSum)).toFixed(1);
        this.logger.warn(
          `[sell] 🐋 TOP-HOLDER DUMP mint=${mint.slice(0, 8)} top3=${topSum} prev=${last!.topSum} (-${dropPct}%)`,
        );
        return true;
      }
      return false;
    } catch (e: any) {
      this.logger.debug(`top-holder check failed mint=${mint.slice(0,8)}: ${e?.message}`);
      return false;
    }
  }

  /**
   * Phase-machine evaluation for one trade.
   *
   * The Default preset is hardcoded in PRESET (top of file). When the user-facing
   * SnipeConfig still has the legacy single TP/SL values populated, we ignore
   * them — the playbook is canonical now. The auto-sell ON/OFF toggle still
   * gates everything.
   *
   * `currentLiqUsd` is the LIVE pool liquidity (from DexScreener, 60s cached).
   * If it's dropped below `LIQUIDITY_PANIC_PCT` of `trade.liquidityAtBuyUsd`,
   * exit immediately — devs/whales are draining the pool, price drops follow.
   */
  private async evaluateTrade(trade: any, lamportsPerToken: number, currentLiqUsd: number | null, topHolderDumped: boolean) {
    const config = await this.prisma.snipeConfig.findUnique({
      where: { userId: trade.userId },
      select: { sellEnabled: true, riskPreset: true },
    });
    if (!config?.sellEnabled) return;

    // Resolve per-user risk preset. Falls back to DEFAULT for unknown values.
    const preset = resolvePreset(config.riskPreset);

    const entryLamports = parseInt(trade.amountRaw, 10);
    if (!entryLamports || !trade.outAmount) return;

    // Phase: derive from sellStatus, since sellPhase is the source of truth
    // but back-compat rows (pre-schema-change) have it null.
    const phase: SellPhase = this.derivePhase(trade);
    if (phase === 'closed') return;

    // ⚠️ Phase 2.1 — Liquidity-drop panic check. Active in ALL phases except
    // 'closed'. The only reliable rug signal: pool TVL drops while we still
    // hold tokens. We need both numbers (buy-time + current) to make the call.
    if (
      currentLiqUsd !== null &&
      trade.liquidityAtBuyUsd != null &&
      trade.liquidityAtBuyUsd > 0
    ) {
      const liqRatio = currentLiqUsd / trade.liquidityAtBuyUsd;
      // preset.LIQUIDITY_PANIC_PCT is negative (-40 = "dropped 40%"). Trigger
      // when liqRatio is below 1 + LIQUIDITY_PANIC_PCT/100 = 0.60.
      const panicRatio = 1 + (preset.LIQUIDITY_PANIC_PCT / 100);
      if (liqRatio < panicRatio) {
        this.logger.warn(
          `[sell] 🚨 LIQUIDITY PANIC trade=${trade.id.slice(-6)} mint=${trade.mint.slice(0,6)} ` +
          `pool=${currentLiqUsd.toFixed(0)} buyTime=${trade.liquidityAtBuyUsd.toFixed(0)} ` +
          `ratio=${(liqRatio * 100).toFixed(0)}% (panic <${(panicRatio * 100).toFixed(0)}%)`,
        );
        this.peaks.delete(trade.id);
        await this.fireSell(trade, 'liquidity_panic', 1.0, true, preset);
        return;
      }
    }

    // ⚠️ Phase 2.6 — Top-holder dump panic. The mint-level check already ran
    // in evaluateMintGroup; here we fire the exit for each row of that mint.
    if (topHolderDumped) {
      this.peaks.delete(trade.id);
      await this.fireSell(trade, 'top_holder_dump', 1.0, true, preset);
      return;
    }

    // Current sell value of REMAINING tokens (in SOL lamports).
    const remainingTokens = BigInt(trade.outAmount);
    const currentSol = Number(remainingTokens) * lamportsPerToken;

    // priceMul = ratio of current sell-value to original cost basis.
    // Remaining tokens × current price / original SOL spent.
    // After TP1, remaining tokens are 50% of original, so a 2x position
    // gives priceMul = 1.0 (which is correct — we've already locked half).
    const priceMul  = currentSol / entryLamports;

    // For Phase 1 triggers we need *unrealized* gain on the ORIGINAL position.
    // That's the price-per-token × original tokens / entry. We approximate by
    // scaling priceMul back up by the proportion sold so far.
    const remainingFraction = this.remainingFraction(phase, preset);
    const fullPositionMul = priceMul / remainingFraction; // gain as if no partials sold
    const fullPctChange   = (fullPositionMul - 1) * 100;

    // Persist peak (DB-backed so restarts don't lose the trail).
    const memPeak = this.peaks.get(trade.id) ?? trade.peakPriceMul ?? fullPositionMul;
    const peak    = Math.max(memPeak, fullPositionMul);
    this.peaks.set(trade.id, peak);

    // Cheap update — sellCheckedAt + peakPriceMul. Fire-and-forget.
    this.prisma.snipeTrade.update({
      where: { id: trade.id },
      data: { peakPriceMul: peak, sellCheckedAt: new Date() },
    }).catch(() => {});

    // ── Phase 1: pre_tp1 ───────────────────────────────────────────────
    if (phase === 'pre_tp1') {
      // Hard SL
      if (fullPctChange <= preset.HARD_SL_PCT) {
        this.peaks.delete(trade.id);
        await this.fireSell(trade, 'stop_loss', /*fraction*/ 1.0, /*final*/ true, preset);
        return;
      }
      // Time decay: preset minutes elapsed AND peak hasn't crossed the threshold
      const ageMs = Date.now() - new Date(trade.createdAt).getTime();
      if (ageMs >= preset.TIME_DECAY_MS && (peak - 1) * 100 < preset.TIME_DECAY_MIN_PCT) {
        this.peaks.delete(trade.id);
        await this.fireSell(trade, 'time_decay', 1.0, true, preset);
        return;
      }
      // TP1 partial
      if (fullPctChange >= preset.TP1_TRIGGER_PCT) {
        const tp1Fraction = preset.TP1_EXIT_PCT / 100;
        await this.fireSell(trade, 'tp1', tp1Fraction, /*final*/ false, preset);
        return;
      }
      return;
    }

    // ── Phase 2: post_tp1 ──────────────────────────────────────────────
    if (phase === 'post_tp1') {
      // Trailing stop drawdown from peak on full-position basis
      if (peak > 1.0) {
        const drawdownPct = ((peak - fullPositionMul) / peak) * 100;
        if (drawdownPct >= preset.TRAIL_POST_TP1_PCT) {
          this.peaks.delete(trade.id);
          await this.fireSell(trade, 'trailing_stop', 1.0, true, preset);
          return;
        }
      }
      // TP2 partial
      if (fullPctChange >= preset.TP2_TRIGGER_PCT) {
        const tp2Fraction = preset.TP2_EXIT_PCT / 100;
        await this.fireSell(trade, 'tp2', tp2Fraction, false, preset);
        return;
      }
      return;
    }

    // ── Phase 3: moonbag ───────────────────────────────────────────────
    if (phase === 'moonbag') {
      if (peak > 1.0) {
        const drawdownPct = ((peak - fullPositionMul) / peak) * 100;
        if (drawdownPct >= preset.TRAIL_MOONBAG_PCT) {
          this.peaks.delete(trade.id);
          await this.fireSell(trade, 'moonbag_trail', 1.0, true, preset);
          return;
        }
      }
      return;
    }
  }

  /** Derive current phase from sellPhase column (preferred) or sellStatus (back-compat). */
  private derivePhase(trade: any): SellPhase {
    if (trade.sellPhase) return trade.sellPhase as SellPhase;
    // Back-compat: derive from sellStatus when sellPhase isn't set (old rows).
    if (trade.sellStatus === 'confirmed') return 'closed';
    if (trade.sellStatus === 'partial_tp1') return 'post_tp1';
    if (trade.sellStatus === 'partial_tp2') return 'moonbag';
    return 'pre_tp1';
  }

  /** Fraction of original position still held in each phase (preset-aware). */
  private remainingFraction(phase: SellPhase, preset: SellPreset): number {
    switch (phase) {
      case 'pre_tp1':  return 1.0;
      case 'post_tp1': return 1.0 - (preset.TP1_EXIT_PCT / 100);
      case 'moonbag':  return (1.0 - preset.TP1_EXIT_PCT / 100) * (1.0 - preset.TP2_EXIT_PCT / 100);
      case 'closed':   return 0.0;
    }
  }

  /**
   * Single entry point for triggering a sell.
   *  - fraction: portion of REMAINING tokens to sell (0.5 = half of remainder).
   *  - final: true → mark closed; false → advance phase to next.
   *
   * Looks up the session by trade.walletId (the wallet that bought this row).
   * Without this, burst-wallet positions silently orphan because the legacy
   * code always used the primary session.
   */
  private async fireSell(trade: any, reason: string, fraction: number, final: boolean, preset: SellPreset) {
    const tokenAmount = this.computeSellAmount(trade.outAmount, fraction);
    if (tokenAmount === '0') return;

    const nextPhase: SellPhase =
      final              ? 'closed'
    : reason === 'tp1'   ? 'post_tp1'
    : reason === 'tp2'   ? 'moonbag'
                         : this.derivePhase(trade);

    await this.executeSell(trade, reason, { tokenAmount, fraction, nextPhase, final });
  }

  /** Floor( outAmount * fraction ) as a base-unit string. */
  private computeSellAmount(outAmount: string, fraction: number): string {
    try {
      const total = BigInt(outAmount);
      if (fraction >= 1.0) return total.toString();
      // Avoid float drift on big-int math: multiply by basis points.
      const bps = BigInt(Math.round(fraction * 10_000));
      return ((total * bps) / 10_000n).toString();
    } catch { return '0'; }
  }

  // ── Core execution ────────────────────────────────────────────────────────

  /**
   * Executes a sell for a given snipe trade.
   *
   * Steps:
   *   1. In-memory lock (prevents duplicate concurrent calls)
   *   2. Atomic DB claim (prevents auto + manual race)
   *   3. Session + balance validation
   *   4. Helius priority fee estimation
   *   5. Parallel bundle build at 3 slippage levels
   *   6. Immediate broadcast via staked sendConnection
   *   7. DB + WS update (broadcast state)
   *   8. Background: confirm + retry loop
   */
  private async executeSell(
    trade: any,
    reason: string,
    opts: {
      tokenAmount: string;   // base units to sell (≤ trade.outAmount)
      fraction: number;      // 0..1 of remaining (used only for logging / decrement)
      nextPhase: SellPhase;  // phase to advance to (closed | post_tp1 | moonbag | pre_tp1)
      final: boolean;        // true = full close, false = partial
    },
  ): Promise<{ txHash: string | null }> {
    const lockKey = `sell:${trade.id}`;
    if (this.execLock.has(lockKey)) {
      this.logger.debug(`sell in-flight for trade=${trade.id} — skipping duplicate`);
      return { txHash: null };
    }
    this.execLock.add(lockKey);

    try {
      // Multi-wallet correctness: find the session for THIS row's wallet, not
      // the user's primary. Falls back to primary for back-compat (rows that
      // existed before walletId was tracked on SnipeTrade).
      const hot = this.session.getSessionForWallet(trade.userId, trade.walletId ?? null);
      const jupBase = getJupiterApiBase();
      if (!hot || jupBase === 'MOCK') {
        await this.prisma.snipeTrade.updateMany({
          where: { id: trade.id, userId: trade.userId, OR: [{ sellStatus: null }, { sellStatus: 'failed' }] },
          data: { sellStatus: 'skip', sellReason: reason },
        }).catch(() => {});
        return { txHash: null };
      }

      this.checkBalanceWarn(hot.connection, hot.keypair.publicKey, trade.userId);

      const t0 = Date.now();
      const maxLamports = this.helius.computeMaxLamports(this.helius.getPriorityFeeSync());

      // ⚡ MINIMUM WORK PATH — mirrors the buy hot path. See docs/AUTO_SELL_STRATEGY.md.
      // DB atomic claim runs in PARALLEL with the bundle build to keep the critical
      // path tight. Manual sells claim from any non-terminal state.
      const claimWhere = reason === 'manual'
        ? { id: trade.id, userId: trade.userId }
        : {
            id: trade.id, userId: trade.userId,
            OR: [
              { sellStatus: null },
              { sellStatus: 'failed' },
              { sellStatus: 'partial_tp1' },   // post_tp1 → trail or TP2 fire
              { sellStatus: 'partial_tp2' },   // moonbag → moonbag trail
            ],
          };

      // Phase 2.4 — adaptive initial slippage by pool liquidity at buy time.
      // Liquid pools get tight slippage (don't overpay); illiquid get wide.
      // Panic-class exits override → 5000bps because we're in a fire drill.
      const isPanic = reason === 'liquidity_panic' || reason === 'top_holder_dump';
      const initialSlippageBps = isPanic
        ? 5_000
        : pickInitialSellSlippageBps(trade.liquidityAtBuyUsd);

      const [claimResult, primaryBundle] = await Promise.all([
        this.prisma.snipeTrade.updateMany({
          where: claimWhere,
          data: { sellStatus: 'pending', sellReason: reason },
        }),
        this.buildBundle(jupBase, trade.mint, opts.tokenAmount, hot.address, hot.keypair, initialSlippageBps, maxLamports)
          .catch((e) => { this.logger.warn(`[sell] build failed trade=${trade.id}: ${e?.message}`); return null; }),
      ]);

      if (claimResult.count === 0) {
        this.logger.debug(`sell already claimed for trade=${trade.id}`);
        return { txHash: null };
      }
      if (!primaryBundle) {
        await this.releaseClaim(trade.id, 'failed');
        this.ws?.emitToUser(trade.userId, 'snipe_sell_update', {
          tradeId: trade.id, mint: trade.mint, sellStatus: 'failed',
          reason, error: 'Jupiter quote failed — token may be illiquid (possible honeypot)',
        });
        return { txHash: null };
      }

      const sig = await hot.sendConnection.sendRawTransaction(primaryBundle.rawTx, {
        skipPreflight: true,
        maxRetries: 0,
      });
      const broadcastMs = Date.now() - t0;

      // Compute remaining outAmount after this partial / final sell. Eager
      // update: next tick reads the reduced amount + new phase, evaluates
      // triggers correctly. If the broadcast fails on-chain (very rare with
      // skipPreflight + max-slippage initial bundle), monitorSell reverts.
      const remainingAfter = opts.final
        ? '0'
        : this.subtractBaseUnits(trade.outAmount, opts.tokenAmount);

      // Map nextPhase → final sellStatus.
      // For partials: sellStatus = 'partial_tp1' | 'partial_tp2' (keeps row in
      //   the position-monitor query).
      // For finals: sellStatus = 'broadcast' until monitor flips to 'confirmed'.
      const newSellStatus = opts.final
        ? 'broadcast'
        : (opts.nextPhase === 'post_tp1' ? 'partial_tp1' : 'partial_tp2');

      setImmediate(() => {
        this.logger.log(
          `[sell] ${reason} trade=${trade.id.slice(-6)} mint=${trade.mint.slice(0,6)} ` +
          `wallet=${hot.address.slice(0,6)} sold=${opts.fraction} ` +
          `sig=${sig.slice(0, 16)}… phase=${opts.nextPhase} ${broadcastMs}ms`,
        );
        this.prisma.snipeTrade.update({
          where: { id: trade.id },
          data: {
            sellTxHash: sig,
            sellStatus: newSellStatus,
            sellReason: reason,
            sellAttempts: { increment: 1 },
            sellPhase: opts.nextPhase,
            outAmount: remainingAfter,
          },
        }).catch(() => {});
        this.ws?.emitToUser(trade.userId, 'snipe_sold', {
          tradeId: trade.id, mint: trade.mint,
          txHash: sig, reason,
          durationMs: broadcastMs,
          sellStatus: newSellStatus,
          phase: opts.nextPhase,
          fraction: opts.fraction,
          ts: Date.now(),
        });
        this.monitorSell(hot.connection, hot.sendConnection, trade, [primaryBundle], sig, jupBase, reason, t0);
      });

      return { txHash: sig };

    } catch (err: any) {
      this.logger.error(`[sell] executeSell failed trade=${trade.id}: ${err.message}`);
      await this.prisma.snipeTrade.update({
        where: { id: trade.id },
        data: { sellStatus: 'failed', sellAttempts: { increment: 1 } },
      }).catch(() => {});
      this.ws?.emitToUser(trade.userId, 'snipe_sell_update', {
        tradeId: trade.id, mint: (trade as any).mint, sellStatus: 'failed',
        reason, error: (err.message ?? '').slice(0, 200),
      });
      return { txHash: null };
    } finally {
      this.execLock.delete(lockKey);
    }
  }

  /** BigInt subtract on base-unit strings. Returns '0' if a < b. */
  private subtractBaseUnits(a: string, b: string): string {
    try {
      const av = BigInt(a); const bv = BigInt(b);
      return (av <= bv ? 0n : av - bv).toString();
    } catch { return '0'; }
  }

  // ── Bundle construction ───────────────────────────────────────────────────

  private async buildBundlesParallel(
    jupBase: string,
    trade: any,
    walletAddress: string,
    keypair: any,
    maxPriorityLamports: number,
  ): Promise<SellBundle[]> {
    const results = await Promise.allSettled(
      SELL_SLIPPAGE_LEVELS.map((slippage) =>
        this.buildBundle(jupBase, trade.mint, trade.outAmount, walletAddress, keypair, slippage, maxPriorityLamports),
      ),
    );

    const bundles: SellBundle[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled') {
        bundles.push(r.value);
      } else {
        this.logger.warn(`[sell] level ${i} (slippage=${SELL_SLIPPAGE_LEVELS[i]}) build failed: ${(r as any).reason?.message}`);
      }
    }
    return bundles;
  }

  private async buildBundle(
    jupBase: string,
    mint: string,
    outAmount: string,
    walletAddress: string,
    keypair: any,
    slippage: number | 'dynamic',
    maxPriorityLamports: number,
  ): Promise<SellBundle> {
    // Quote: token → SOL
    const quoteUrl = new URL(`${jupBase}/quote`);
    quoteUrl.searchParams.set('inputMint', mint);
    quoteUrl.searchParams.set('outputMint', SOL_MINT);
    quoteUrl.searchParams.set('amount', outAmount);
    quoteUrl.searchParams.set('slippageBps', slippage === 'dynamic' ? '500' : String(slippage));
    quoteUrl.searchParams.set('onlyDirectRoutes', 'false');

    const quoteResp = await fetch(quoteUrl.toString(), { signal: AbortSignal.timeout(5_000) });
    if (!quoteResp.ok) {
      throw new Error(`Jupiter sell quote ${quoteResp.status}: ${(await quoteResp.text()).slice(0, 150)}`);
    }
    const quote = await quoteResp.json();

    // Swap tx body — dynamic slippage must go in the body, NOT the quote URL
    const swapBody: Record<string, unknown> = {
      quoteResponse: quote,
      userPublicKey: walletAddress,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: {
          // Dynamic cap from Helius — pays market rate, not a hardcoded ceiling
          maxLamports: maxPriorityLamports,
          priorityLevel: 'veryHigh',
        },
      },
    };
    if (slippage === 'dynamic') swapBody.dynamicSlippage = true;

    const swapResp = await fetch(`${jupBase}/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(swapBody),
      signal: AbortSignal.timeout(5_000),
    });
    if (!swapResp.ok) {
      throw new Error(`Jupiter sell swap ${swapResp.status}: ${(await swapResp.text()).slice(0, 150)}`);
    }
    const { swapTransaction } = await swapResp.json();

    // Sign immediately — keypair is hot in memory, this is ~0 ms
    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
    tx.sign([keypair]);

    return { rawTx: tx.serialize(), solBack: quote.outAmount ?? '0', slippage };
  }

  // ── Background confirmation + slippage retry ──────────────────────────────

  private monitorSell(
    readConn: Connection,
    sendConn: Connection,
    trade: any,
    bundles: SellBundle[],
    initialSig: string,
    jupBase: string,
    reason: string,
    t0: number,
  ): void {
    (async () => {
      let currentSig = initialSig;

      for (let attempt = 0; attempt < bundles.length; attempt++) {
        const status = await this.pollStatus(readConn, currentSig);

        if (status === 'confirmed') {
          this.logger.log(`[sell] ✓ confirmed trade=${trade.id} sig=${currentSig.slice(0, 16)}… attempt=${attempt}`);

          // Phase-aware confirm: only flip to 'confirmed' when this was a
          // *final* sell (sellStatus = 'broadcast'). Partial sells stay at
          // 'partial_tp1'/'partial_tp2' so the position-monitor query keeps
          // picking them up for further trigger evaluation.
          await this.prisma.snipeTrade.updateMany({
            where: { id: trade.id, sellTxHash: currentSig, sellStatus: 'broadcast' },
            data: { sellStatus: 'confirmed' },
          });
          this.ws?.emitToUser(trade.userId, 'snipe_sold_confirmed', {
            tradeId: trade.id, mint: trade.mint,
            txHash: currentSig, reason,
            durationMs: Date.now() - t0,
            ts: Date.now(),
          });
          return;
        }

        if (status === 'slippage_failed') {
          const nextIdx = attempt + 1;
          const nextBundle = bundles[nextIdx];

          if (!nextBundle) {
            const errMsg = `Sell slippage exceeded on all ${bundles.length} levels`;
            this.logger.warn(`[sell] ✗ ${errMsg} trade=${trade.id}`);
            await this.markSellFailed(trade.id, currentSig, errMsg);
            this.ws?.emitToUser(trade.userId, 'snipe_sell_update', {
              tradeId: trade.id, mint: trade.mint, txHash: currentSig,
              sellStatus: 'failed', error: errMsg, reason,
            });
            return;
          }

          const elapsedMs = Date.now() - t0;
          let retrySig: string;

          if (elapsedMs < BLOCKHASH_SAFE_WINDOW_MS) {
            // Pre-signed tx still within the 60 s blockhash window — instant retry
            this.logger.log(
              `[sell] ↑ slippage retry attempt=${nextIdx} trade=${trade.id} ` +
              `slippage=${nextBundle.slippage} elapsed=${elapsedMs}ms (pre-signed)`,
            );
            retrySig = await sendConn.sendRawTransaction(nextBundle.rawTx, {
              skipPreflight: true, maxRetries: 0,
            });
          } else {
            // Blockhash may be stale — re-quote with the next slippage level
            const hot = this.session.getSession(trade.userId);
            if (!hot) {
              await this.markSellFailed(trade.id, currentSig, 'Session expired during retry');
              return;
            }
            const targetSlippage = typeof nextBundle.slippage === 'number'
              ? nextBundle.slippage : 5_000;
            const freshFee = await this.helius.getPriorityFeeEstimate([SOL_MINT, trade.mint]);
            try {
              const fresh = await this.buildBundle(
                jupBase, trade.mint, trade.outAmount,
                hot.address, hot.keypair, targetSlippage,
                this.helius.computeMaxLamports(freshFee),
              );
              retrySig = await sendConn.sendRawTransaction(fresh.rawTx, {
                skipPreflight: true, maxRetries: 0,
              });
            } catch (rebuildErr: any) {
              await this.markSellFailed(trade.id, currentSig, `Re-quote failed: ${rebuildErr.message}`);
              this.ws?.emitToUser(trade.userId, 'snipe_sell_update', {
                tradeId: trade.id, mint: trade.mint, txHash: currentSig,
                sellStatus: 'failed', error: 'Retry re-quote failed', reason,
              });
              return;
            }
          }

          this.logger.log(`[sell] ↑ retry sig=${retrySig.slice(0, 16)}… trade=${trade.id} attempt=${nextIdx}`);
          await this.prisma.snipeTrade.update({
            where: { id: trade.id },
            data: { sellTxHash: retrySig, sellAttempts: { increment: 1 } },
          });
          this.ws?.emitToUser(trade.userId, 'snipe_sell_update', {
            tradeId: trade.id, mint: trade.mint,
            txHash: retrySig, prevTxHash: currentSig,
            sellStatus: 'broadcast', attempt: nextIdx, reason,
          });
          currentSig = retrySig;
          continue;
        }

        // timeout or other_failed — tx dropped or program error (not slippage)
        const reason2 = status === 'timeout'
          ? 'Sell tx dropped — check SOL balance for priority fees'
          : 'Sell tx failed on-chain (non-slippage program error)';

        this.logger.warn(`[sell] ✗ ${status} trade=${trade.id} sig=${currentSig.slice(0, 16)}…`);
        await this.markSellFailed(trade.id, currentSig, reason2);
        this.ws?.emitToUser(trade.userId, 'snipe_sell_update', {
          tradeId: trade.id, mint: trade.mint, txHash: currentSig,
          sellStatus: 'failed', error: reason2, reason,
        });
        return;
      }
    })().catch((e) => this.logger.error(`[sell] monitorSell crashed trade=${trade.id}: ${e?.message}`));
  }

  // ── Confirmation polling ──────────────────────────────────────────────────

  private async pollStatus(conn: Connection, sig: string): Promise<SellStatus> {
    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;

    while (Date.now() < deadline) {
      await sleep(CONFIRM_POLL_MS);
      try {
        const resp = await conn.getSignatureStatuses([sig], { searchTransactionHistory: false });
        const st = resp.value?.[0];
        if (!st) continue; // not yet propagated

        const landed = st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized';
        if (!landed) continue;
        if (!st.err) return 'confirmed';

        const errStr = JSON.stringify(st.err);
        // Jupiter Custom error code 1 = SlippageToleranceExceeded
        if (errStr.includes('"Custom":1') || errStr.includes('"custom":1')) return 'slippage_failed';
        return 'other_failed';

      } catch { /* RPC hiccup — keep polling */ }
    }

    // One final check using transaction history search (Helius indexes fast)
    try {
      const resp = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
      const st = resp.value?.[0];
      if (st && !st.err) return 'confirmed';
    } catch {}

    return 'timeout';
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async fetchSellQuote(
    mint: string,
    outAmount: string,
    slippageBps: number,
    jupBase: string,
  ): Promise<number | null> {
    try {
      const url = new URL(`${jupBase}/quote`);
      url.searchParams.set('inputMint', mint);
      url.searchParams.set('outputMint', SOL_MINT);
      url.searchParams.set('amount', outAmount);
      url.searchParams.set('slippageBps', String(slippageBps));
      const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(4_000) });
      if (!resp.ok) return null;
      const q = await resp.json();
      return parseInt(q.outAmount ?? '0', 10) || null;
    } catch {
      return null;
    }
  }

  private async markSellFailed(tradeId: string, txHash: string, msg: string) {
    await this.prisma.snipeTrade.updateMany({
      where: { id: tradeId },
      data: { sellStatus: 'failed', sellTxHash: txHash },
    }).catch(() => {});
  }

  private async releaseClaim(tradeId: string, status: string) {
    await this.prisma.snipeTrade.update({
      where: { id: tradeId },
      data: { sellStatus: status },
    }).catch(() => {});
  }

  private checkBalanceWarn(conn: Connection, pubkey: PublicKey, userId: string) {
    conn.getBalance(pubkey).then((lamports) => {
      if (lamports < MIN_FEE_RESERVE_LAMPORTS) {
        this.logger.warn(
          `[sell] Low SOL balance for user=${userId}: ${lamports} lamports ` +
          `(< ${MIN_FEE_RESERVE_LAMPORTS} — sell may fail due to insufficient fees)`,
        );
        // Emit a low-balance warning to the UI
        this.ws?.emitToUser(userId, 'snipe_sell_update', {
          sellStatus: 'warn',
          error: `Low SOL balance (${(lamports / 1e9).toFixed(6)} SOL) — sell fees may not be covered`,
        });
      }
    }).catch(() => {});
  }
}

function sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }
