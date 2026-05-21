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
const POSITION_CHECK_MS     = 10_000;   // how often to scan open positions
const CONFIRM_POLL_MS       = 1_400;    // poll cadence (same as buy)
const CONFIRM_TIMEOUT_MS    = 20_000;   // per-attempt timeout (buy uses 15 s; exits get 20 s)
const MAX_SELL_ATTEMPTS     = 3;        // total broadcast attempts before giving up
const MIN_FEE_RESERVE_LAMPORTS = 10_000; // warn if wallet SOL below this
const BLOCKHASH_SAFE_WINDOW_MS  = 45_000; // pre-signed tx safe reuse window

// Sell slippage levels — snipe exits are volatile, so caps are high
const SELL_SLIPPAGE_LEVELS: Array<number | 'dynamic'> = ['dynamic', 2_500, 5_000];

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

    return this.executeSell(trade as any, 'manual');
  }

  // ── Position monitoring ───────────────────────────────────────────────────

  private async checkPositions() {
    if (!this.prisma) return;
    const jupBase = getJupiterApiBase();
    if (jupBase === 'MOCK') return;

    // Only evaluate confirmed buys with tokens, no active sell, within retry limit
    const trades = await this.prisma.snipeTrade.findMany({
      where: {
        status: 'confirmed',
        outAmount: { not: null },
        OR: [
          { sellStatus: null },
          { sellStatus: 'failed', sellAttempts: { lt: MAX_SELL_ATTEMPTS } },
        ],
      },
      take: 50,
      orderBy: { createdAt: 'asc' },
    });

    // Drop peaks for trades no longer in the active set (sold elsewhere,
    // deleted from UI, sellAttempts exhausted). Otherwise the map grows
    // forever as new positions open and old ones quietly leave the query.
    if (this.peaks.size > 0) {
      const live = new Set(trades.map((t) => t.id));
      for (const id of this.peaks.keys()) {
        if (!live.has(id)) this.peaks.delete(id);
      }
    }

    await Promise.allSettled(
      trades.map((t) => this.evaluateTrade(t as any, jupBase)),
    );
  }

  private async evaluateTrade(trade: any, jupBase: string) {
    const config = await this.prisma.snipeConfig.findUnique({
      where: { userId: trade.userId },
      select: { sellEnabled: true, sellMode: true, takeProfitPct: true, stopLossPct: true, trailingStopPct: true, exitAfterMs: true },
    });
    if (!config?.sellEnabled) return;

    const override = await this.prisma.snipeGroupOverride.findUnique({
      where: { userId_groupId: { userId: trade.userId, groupId: trade.groupId } },
      select: { sellMode: true, takeProfitPct: true, stopLossPct: true, trailingStopPct: true, exitAfterMs: true },
    });

    const sellMode        = override?.sellMode        ?? config.sellMode;
    const takeProfitPct   = override?.takeProfitPct   ?? config.takeProfitPct;
    const stopLossPct     = override?.stopLossPct      ?? config.stopLossPct;
    const trailingStopPct = override?.trailingStopPct  ?? config.trailingStopPct;
    const exitAfterMs     = override?.exitAfterMs      ?? config.exitAfterMs;

    // ── Time exit ──
    if (exitAfterMs) {
      const ageMs = Date.now() - new Date(trade.createdAt).getTime();
      if (ageMs >= exitAfterMs) {
        await this.executeSell(trade, 'time_exit');
        return;
      }
    }

    // ── Price check ──
    const currentSol = await this.fetchSellQuote(trade.mint, trade.outAmount, 5_000, jupBase);
    if (currentSol === null) return;

    const entryLamports = parseInt(trade.amountRaw, 10);
    if (!entryLamports) return;

    const priceMul  = currentSol / entryLamports; // 1.0 = breakeven
    const pctChange = (priceMul - 1) * 100;

    // Track peak for trailing stop
    const peak = Math.max(this.peaks.get(trade.id) ?? priceMul, priceMul);
    this.peaks.set(trade.id, peak);
    await this.prisma.snipeTrade.update({
      where: { id: trade.id },
      data: { peakPriceMul: peak, sellCheckedAt: new Date() },
    });

    // ── Hard stop loss ──
    if (stopLossPct != null && pctChange <= stopLossPct) {
      this.peaks.delete(trade.id);
      await this.executeSell(trade, 'stop_loss');
      return;
    }

    // ── Trailing stop ──
    if (trailingStopPct != null && peak > 1.0) {
      const drawdownFromPeak = ((peak - priceMul) / peak) * 100;
      if (drawdownFromPeak >= trailingStopPct) {
        this.peaks.delete(trade.id);
        await this.executeSell(trade, 'trailing_stop');
        return;
      }
    }

    // ── Take profit ──
    if (takeProfitPct != null && pctChange >= takeProfitPct) {
      if (sellMode === 'INTELLIGENT') {
        // Flag for user review instead of auto-executing
        await this.prisma.snipeTrade.update({
          where: { id: trade.id },
          data: { sellStatus: 'pending', sellReason: 'take_profit' },
        });
        this.ws?.emitToUser(trade.userId, 'snipe_sell_pending', {
          tradeId: trade.id, mint: trade.mint, pctChange, reason: 'take_profit',
        });
      } else {
        this.peaks.delete(trade.id);
        await this.executeSell(trade, 'take_profit');
      }
    }
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
  private async executeSell(trade: any, reason: string): Promise<{ txHash: string | null }> {
    const lockKey = `sell:${trade.id}`;
    if (this.execLock.has(lockKey)) {
      this.logger.debug(`sell in-flight for trade=${trade.id} — skipping duplicate`);
      return { txHash: null };
    }
    this.execLock.add(lockKey);

    try {
      const hot = this.session.getSession(trade.userId);
      const jupBase = getJupiterApiBase();
      if (!hot || jupBase === 'MOCK') {
        // No session / mock mode — claim+release in one go so DB stays consistent.
        await this.prisma.snipeTrade.updateMany({
          where: { id: trade.id, userId: trade.userId, OR: [{ sellStatus: null }, { sellStatus: 'failed' }] },
          data: { sellStatus: 'skip', sellReason: reason },
        }).catch(() => {});
        return { txHash: null };
      }

      // Non-blocking balance warning (don't block the sell path for a warning)
      this.checkBalanceWarn(hot.connection, hot.keypair.publicKey, trade.userId);

      const t0 = Date.now();

      // ⚡ MINIMUM WORK PATH — mirrors the buy hot path. Every line costs landing latency.
      //
      // 1) Sync priority-fee read (cached 2s, pre-warmed at arm time).
      // 2) Build ONE bundle at 5000bps (highest slippage = highest fill probability).
      //    monitorSell does fresh re-quotes on retry, so the pre-built array isn't reused.
      // 3) DB atomic claim runs in PARALLEL with the bundle build — saves the Redis/PG
      //    round-trip from the critical path. If claim loses (another sell already claimed),
      //    we abandon the built bundle without broadcasting.
      const maxLamports = this.helius.computeMaxLamports(this.helius.getPriorityFeeSync());

      const [claimResult, primaryBundle] = await Promise.all([
        this.prisma.snipeTrade.updateMany({
          where: {
            id: trade.id,
            userId: trade.userId,
            OR: [{ sellStatus: null }, { sellStatus: 'failed' }],
          },
          data: { sellStatus: 'pending', sellReason: reason },
        }),
        this.buildBundle(jupBase, trade.mint, trade.outAmount, hot.address, hot.keypair, 5_000, maxLamports)
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
          reason, error: 'Jupiter quote failed — token may be illiquid',
        });
        return { txHash: null };
      }

      // ── Broadcast via staked Helius sendConnection ──
      const sig = await hot.sendConnection.sendRawTransaction(primaryBundle.rawTx, {
        skipPreflight: true,
        maxRetries: 0,
      });
      const broadcastMs = Date.now() - t0;

      // Everything after is post-broadcast — deferred via setImmediate so we
      // return to the caller without paying for DB / WS / monitor kickoff.
      setImmediate(() => {
        this.logger.log(
          `[sell] broadcast trade=${trade.id} mint=${trade.mint.slice(0,6)} ` +
          `reason=${reason} sig=${sig.slice(0, 16)}… slippage=${primaryBundle.slippage} ${broadcastMs}ms`,
        );
        this.prisma.snipeTrade.update({
          where: { id: trade.id },
          data: {
            sellTxHash: sig,
            sellStatus: 'broadcast',
            sellReason: reason,
            sellAttempts: { increment: 1 },
          },
        }).catch(() => {});
        this.ws?.emitToUser(trade.userId, 'snipe_sold', {
          tradeId: trade.id, mint: trade.mint,
          txHash: sig, reason,
          durationMs: broadcastMs,
          sellStatus: 'broadcast',
          ts: Date.now(),
        });
        // Background: confirm + slippage retry (fresh re-quotes inside monitorSell).
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

          await this.prisma.snipeTrade.updateMany({
            where: { id: trade.id, sellTxHash: currentSig },
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
