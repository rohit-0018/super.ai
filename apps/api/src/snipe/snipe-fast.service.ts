import { Injectable, Logger, Optional } from '@nestjs/common';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../ws/realtime.gateway';
import { getJupiterApiBase } from '../common/network-config';
import { SnipeSessionService, CachedSnipeConfig } from './snipe-session.service';
import { HeliusService } from './helius.service';
import { newTraceId } from '../common/trace-context';
import { TokenMetadataService } from '../market-data/token-metadata.service';
import { CoinGeckoProvider } from '../market-data/providers/coingecko.provider';
import { TokenAnalysisService } from '../token-analysis/token-analysis.service';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Blockhash validity on Solana: ~150 slots ≈ 60 s.
// We retry within 15 s per attempt so pre-signed txs never expire.
const CONFIRM_POLL_INTERVAL_MS = 1_400; // fast polling for quick failure detection
const CONFIRM_TIMEOUT_MS = 15_000;      // give each attempt 15 s before giving up

export interface SnipeResult {
  txHash: string | null;
  outAmount: string;
  traceId: string;
  durationMs: number;
}

interface SwapBundle {
  tx: VersionedTransaction;
  rawTx: Uint8Array;
  outAmount: string;
  slippageBps: number | 'dynamic';
}

type ConfirmStatus = 'confirmed' | 'slippage_failed' | 'other_failed' | 'timeout';

/**
 * Zero-overhead fast path for token sniping.
 *
 * Pre-builds transactions at multiple slippage levels in parallel before
 * broadcasting anything. On a slippage failure the next pre-signed tx is
 * broadcast in < 50 ms — no re-quote round-trip needed.
 *
 * Slippage escalation (given maxSlippageBps):
 *   Level 0: Jupiter dynamic slippage  (cheapest, tries optimal)
 *   Level 1: 30 % of max
 *   Level 2: 65 % of max
 *   Level 3: 100 % of max
 *
 * If any level's blockhash has expired (rare: only if overall elapsed > 60 s),
 * we re-quote fresh rather than broadcast a dead transaction.
 */
@Injectable()
export class SnipeFastService {
  private readonly logger = new Logger(SnipeFastService.name);

  // Prevents two concurrent snipe calls from racing on the same userId+mint pair.
  // Set is populated before any async work and cleared in finally.
  private readonly execLock = new Set<string>();

  constructor(
    private prisma: PrismaService,
    private snipeSession: SnipeSessionService,
    private helius: HeliusService,
    @Optional() private ws: RealtimeGateway,
    @Optional() private tokenMeta?: TokenMetadataService,
    @Optional() private coingecko?: CoinGeckoProvider,
    @Optional() private tokenAnalysis?: TokenAnalysisService,
  ) {}

  async execute(
    config: CachedSnipeConfig,
    mint: string,
    groupId: string,
    sourceMsg: string,
  ): Promise<SnipeResult> {
    const t0 = Date.now();
    const traceId = newTraceId();

    // ── Guard 1: in-flight lock — prevents two concurrent calls racing on the same mint ─
    const lockKey = `${config.userId}:${mint}`;
    if (this.execLock.has(lockKey)) {
      this.logger.log(`[trc=${traceId}] ⏭ already executing ${mint} for user=${config.userId} — skipping duplicate`);
      return { txHash: null, outAmount: '0', traceId, durationMs: Date.now() - t0 };
    }
    this.execLock.add(lockKey);

    try {

    // ── Guard 2: DB check — if this mint was already confirmed for this user, do not rebuy ─
    const existingBuy = await this.prisma.snipeTrade.findFirst({
      where: {
        userId: config.userId,
        mint,
        status: { in: ['confirmed', 'broadcast'] },
        createdAt: { gte: new Date(Date.now() - 300_000) }, // within last 5 min
      },
      select: { id: true, txHash: true, status: true },
    });
    if (existingBuy) {
      this.logger.log(
        `[trc=${traceId}] ⏭ mint=${mint} already ${existingBuy.status} (id=${existingBuy.id}) — killing duplicate buy`,
      );
      return { txHash: existingBuy.txHash, outAmount: '0', traceId, durationMs: Date.now() - t0 };
    }

    const session = this.snipeSession.getSession(config.userId);

    if (!session) {
      this.logger.warn(`[trc=${traceId}] No hot session for user=${config.userId} — skipping ${mint}`);
      return { txHash: null, outAmount: '0', traceId, durationMs: Date.now() - t0 };
    }

    const jupBase = getJupiterApiBase();
    if (jupBase === 'MOCK') {
      const err = 'Jupiter unavailable in testnet mode — set NETWORK_MODE=mainnet to execute real trades';
      this.logger.warn(`[trc=${traceId}] ${err}`);
      await this.recordTrade(config, mint, '0', null, groupId, sourceMsg, 'failed', err);
      return { txHash: null, outAmount: '0', traceId, durationMs: Date.now() - t0 };
    }

    try {
      // ── Get Helius priority fee (cached 2 s, nearly free on warm path) ──────
      const feeEstimate = await this.helius.getPriorityFeeEstimate();
      const maxPriorityLamports = this.helius.computeMaxLamports(feeEstimate);

      // ── Build all slippage levels in parallel ──────────────────────────────
      const levels = this.buildSlippageLevels(config.maxSlippageBps);
      const bundles = await this.buildBundlesParallel(
        jupBase, mint, config.buyAmountRaw, session.address, session.keypair,
        levels, traceId, maxPriorityLamports,
      );

      if (bundles.length === 0) throw new Error('All parallel quote attempts failed');

      const primary = bundles[0];
      const durationPrep = Date.now() - t0;
      this.logger.log(
        `[trc=${traceId}] ⚡ ${bundles.length} tx bundles ready (${durationPrep}ms) — ` +
        `broadcasting level 0 slippage=${primary.slippageBps} maxFee=${maxPriorityLamports}lamports`,
      );

      // ── Broadcast via staked Helius sendConnection (processed commitment) ───
      const sig0 = await session.sendConnection.sendRawTransaction(primary.rawTx, {
        skipPreflight: true,
        maxRetries: 0, // we retry ourselves in monitorWithRetry
      });

      const durationMs = Date.now() - t0;
      this.logger.log(`[trc=${traceId}] ⚡ snipe broadcast mint=${mint} sig=${sig0} duration=${durationMs}ms`);

      // Record the initial broadcast
      await this.recordTrade(config, mint, primary.outAmount, sig0, groupId, sourceMsg, 'broadcast');

      // Snapshot mcap / price / SOL-USD at fill time so the row carries accurate
      // historical context even after token prices drift. Best-effort, never blocks.
      this.attachBuySnapshot(config.userId, mint, sig0, traceId).catch((e) => {
        this.logger.debug(`[trc=${traceId}] snapshot failed for ${mint}: ${e?.message}`);
      });

      this.ws?.emitToUser(config.userId, 'snipe_triggered', {
        mint, txHash: sig0, durationMs,
        amountRaw: config.buyAmountRaw, outAmount: primary.outAmount,
        groupId, status: 'broadcast', ts: Date.now(),
      });

      // ── Background: confirm + retry on slippage failure ───────────────────
      // readConn (confirmed) for status polling; sendConn (staked/processed) for retries
      this.monitorWithRetry(
        session.connection, session.sendConnection, config, mint, groupId, sourceMsg,
        bundles, sig0, jupBase, traceId, t0,
      );

      return { txHash: sig0, outAmount: primary.outAmount, traceId, durationMs };

    } catch (err: any) {
      const durationMs = Date.now() - t0;
      const errMsg: string = err.message ?? 'Unknown error';
      this.logger.error(`[trc=${traceId}] snipe failed mint=${mint} err=${errMsg} duration=${durationMs}ms`);
      this.recordTrade(config, mint, '0', null, groupId, sourceMsg, 'failed', errMsg).catch(() => {});
      this.ws?.emitToUser(config.userId, 'snipe_triggered', {
        mint, txHash: null, durationMs,
        amountRaw: config.buyAmountRaw, outAmount: '0',
        groupId, status: 'failed',
        error: errMsg.slice(0, 200), ts: Date.now(),
      });
      return { txHash: null, outAmount: '0', traceId, durationMs };
    }

    } finally {
      // Release lock so later messages for the same mint can proceed after confirmation
      this.execLock.delete(lockKey);
    }
  }

  // ── Slippage level computation ──────────────────────────────────────────────

  private buildSlippageLevels(maxBps: number): Array<number | 'dynamic'> {
    // Level 0: dynamic (Jupiter picks optimal — cheapest, ~50-200 bps for liquid tokens)
    // Level 1: 30% of max
    // Level 2: 65% of max
    // Level 3: 100% of max
    const l1 = Math.round(maxBps * 0.30);
    const l2 = Math.round(maxBps * 0.65);
    // Deduplicate: if max is very low (< 300 bps) some levels collapse
    const explicit = [...new Set([l1, l2, maxBps].filter((b) => b >= 50))];
    return ['dynamic', ...explicit];
  }

  // ── Parallel bundle preparation ─────────────────────────────────────────────

  private async buildBundlesParallel(
    jupBase: string,
    mint: string,
    amountRaw: string,
    walletAddress: string,
    keypair: Keypair,
    levels: Array<number | 'dynamic'>,
    traceId: string,
    maxPriorityLamports = 1_000_000,
  ): Promise<SwapBundle[]> {
    const results = await Promise.allSettled(
      levels.map((level) => this.buildBundle(jupBase, mint, amountRaw, walletAddress, keypair, level, maxPriorityLamports)),
    );

    const bundles: SwapBundle[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled') {
        bundles.push(r.value);
      } else {
        const reason = r.reason;
        const cause = reason?.cause;
        this.logger.warn(
          `[trc=${traceId}] level ${i} (${levels[i]}) pre-build failed: ${reason?.message} ` +
            `name=${reason?.name} code=${reason?.code ?? cause?.code} ` +
            `causeName=${cause?.name} causeMsg=${cause?.message} ` +
            `stack=${reason?.stack?.split('\n').slice(0, 3).join(' | ')}`,
        );
      }
    }
    return bundles;
  }

  private async buildBundle(
    jupBase: string,
    mint: string,
    amountRaw: string,
    walletAddress: string,
    keypair: Keypair,
    slippage: number | 'dynamic',
    maxPriorityLamports = 1_000_000,
  ): Promise<SwapBundle> {
    // Quote
    const quoteUrl = new URL(`${jupBase}/quote`);
    quoteUrl.searchParams.set('inputMint', SOL_MINT);
    quoteUrl.searchParams.set('outputMint', mint);
    quoteUrl.searchParams.set('amount', amountRaw);
    if (slippage === 'dynamic') {
      quoteUrl.searchParams.set('slippageBps', '500'); // seed — overridden by dynamicSlippage in swap
    } else {
      quoteUrl.searchParams.set('slippageBps', String(slippage));
    }
    quoteUrl.searchParams.set('onlyDirectRoutes', 'false');

    const quoteResp = await fetch(quoteUrl.toString(), { signal: AbortSignal.timeout(5_000) });
    if (!quoteResp.ok) throw new Error(`Jupiter quote ${quoteResp.status}: ${(await quoteResp.text()).slice(0, 200)}`);
    const quote = await quoteResp.json();

    // Swap tx
    const swapBody: Record<string, unknown> = {
      quoteResponse: quote,
      userPublicKey: walletAddress,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: {
          maxLamports: maxPriorityLamports, // Dynamic cap from Helius estimate
          priorityLevel: 'veryHigh',
        },
      },
    };
    if (slippage === 'dynamic') {
      swapBody.dynamicSlippage = true;
    }

    const swapResp = await fetch(`${jupBase}/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(swapBody),
      signal: AbortSignal.timeout(5_000),
    });
    if (!swapResp.ok) throw new Error(`Jupiter swap ${swapResp.status}: ${(await swapResp.text()).slice(0, 200)}`);
    const { swapTransaction } = await swapResp.json();

    // Sign immediately — keypair is already in memory, this is ~0 ms
    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
    tx.sign([keypair]);

    return { tx, rawTx: tx.serialize(), outAmount: quote.outAmount ?? '0', slippageBps: slippage };
  }

  // ── Background confirmation + retry loop ────────────────────────────────────

  private monitorWithRetry(
    conn: Connection,       // confirmed — status polling
    sendConn: Connection,   // processed/staked — retry sends
    config: CachedSnipeConfig,
    mint: string,
    groupId: string,
    sourceMsg: string,
    bundles: SwapBundle[],
    initialSig: string,
    jupBase: string,
    traceId: string,
    t0: number,
  ): void {
    (async () => {
      let currentSig = initialSig;
      let attemptCount = 1; // attempt 1 already broadcast by execute()

      for (let attempt = 0; attempt < bundles.length; attempt++) {
        const status = await this.waitForStatus(conn, currentSig, traceId);

        if (status === 'confirmed') {
          this.logger.log(`[trc=${traceId}] ✓ confirmed attempt=${attempt} sig=${currentSig.slice(0, 16)}…`);
          await this.prisma.snipeTrade.updateMany({
            where: { txHash: currentSig, status: 'broadcast' },
            data: { status: 'confirmed' },
          });
          this.ws?.emitToUser(config.userId, 'snipe_update', { txHash: currentSig, status: 'confirmed' });
          // Track-record capture — fire-and-forget. Real money was just put in,
          // so this is the highest-signal source for the marketing surface.
          // Goes through analyzeAddress so the snapshot has the same depth as
          // any manual scan (AI verdict, holder metrics, social signals).
          if (this.tokenAnalysis) {
            this.tokenAnalysis.analyzeAddress(mint, false, 'snipe').catch((e: any) => {
              this.logger.debug(`[trc=${traceId}] intel-track snipe capture failed: ${e?.message}`);
            });
          }
          return;
        }

        if (status === 'slippage_failed') {
          // Before retrying, check if this mint was already bought by a concurrent path
          const alreadyDone = await this.prisma.snipeTrade.findFirst({
            where: {
              userId: config.userId,
              mint,
              status: 'confirmed',
            },
            select: { id: true, txHash: true },
          });
          if (alreadyDone) {
            this.logger.log(
              `[trc=${traceId}] ⏹ mint=${mint} already confirmed (${alreadyDone.txHash?.slice(0, 10)}) — aborting retry loop, marking this attempt failed`,
            );
            await this.markFailed(currentSig, 'Aborted: mint already bought by another concurrent transaction');
            return;
          }

          const nextAttempt = attempt + 1;

          // Build the retry bundle — use pre-fetched if still fresh, else re-quote
          let retrySig: string;
          let retryOut: string;

          const prebuilt = bundles[nextAttempt];
          const elapsedMs = Date.now() - t0;

          if (prebuilt && elapsedMs < 45_000) {
            // Pre-signed tx still well within the 60 s blockhash window — broadcast instantly
            this.logger.log(
              `[trc=${traceId}] ↑ slippage retry attempt=${nextAttempt} ` +
              `slippage=${prebuilt.slippageBps} (pre-signed, ${elapsedMs}ms elapsed)`,
            );
            retrySig = await sendConn.sendRawTransaction(prebuilt.rawTx, { skipPreflight: true, maxRetries: 0 });
            retryOut = prebuilt.outAmount;
          } else if (nextAttempt < bundles.length || prebuilt) {
            // Blockhash might be stale — re-quote with the target slippage level
            const targetBps = prebuilt?.slippageBps === 'dynamic'
              ? config.maxSlippageBps
              : (prebuilt?.slippageBps ?? config.maxSlippageBps);

            this.logger.log(
              `[trc=${traceId}] ↑ slippage retry attempt=${nextAttempt} slippage=${targetBps} (fresh re-quote, ${elapsedMs}ms elapsed)`,
            );
            try {
              const fresh = await this.buildBundle(
                jupBase, mint, config.buyAmountRaw,
                bundles[0].tx.message.staticAccountKeys[0].toBase58(),
                // re-sign with keypair from session (retrieve from cache)
                (this.snipeSession.getSession(config.userId))!.keypair,
                typeof targetBps === 'number' ? targetBps : config.maxSlippageBps,
              );
              retrySig = await sendConn.sendRawTransaction(fresh.rawTx, { skipPreflight: true, maxRetries: 0 });
              retryOut = fresh.outAmount;
            } catch (buildErr: any) {
              this.logger.error(`[trc=${traceId}] re-quote for retry failed: ${buildErr.message}`);
              await this.markFailed(currentSig, `Slippage exceeded; retry re-quote failed: ${buildErr.message}`);
              this.ws?.emitToUser(config.userId, 'snipe_update', { txHash: currentSig, status: 'failed', error: 'Retry re-quote failed' });
              return;
            }
          } else {
            // All levels exhausted
            const msg = `Slippage exceeded on all ${bundles.length} attempts (max=${config.maxSlippageBps}bps)`;
            this.logger.warn(`[trc=${traceId}] ✗ ${msg}`);
            await this.markFailed(currentSig, msg);
            this.ws?.emitToUser(config.userId, 'snipe_triggered', {
              mint, txHash: currentSig, durationMs: Date.now() - t0,
              amountRaw: config.buyAmountRaw, outAmount: '0',
              groupId, status: 'failed', error: msg, ts: Date.now(),
            });
            return;
          }

          // Update DB: record the retry sig (overwrite broadcast sig so UI shows the real final tx)
          attemptCount += 1;
          await this.prisma.snipeTrade.updateMany({
            where: { txHash: currentSig },
            data: { txHash: retrySig, outAmount: retryOut, status: 'broadcast', attempts: attemptCount },
          });
          this.ws?.emitToUser(config.userId, 'snipe_update', {
            txHash: retrySig, prevTxHash: currentSig, status: 'retrying',
            attempt: nextAttempt,
          });
          currentSig = retrySig;
          continue;
        }

        if (status === 'timeout') {
          // Tx was never indexed — likely dropped (0 SOL balance or RPC issue)
          const msg = 'Transaction dropped — wallet likely has insufficient SOL for fees. Fund the wallet and try again.';
          this.logger.warn(`[trc=${traceId}] ✗ tx timed out sig=${currentSig.slice(0, 16)}…`);
          await this.markFailed(currentSig, msg);
          this.ws?.emitToUser(config.userId, 'snipe_update', { txHash: currentSig, status: 'failed', error: msg });
          return;
        }

        // other_failed (non-slippage program error or infra error)
        const msg = `Transaction failed (non-slippage): ${status}`;
        this.logger.warn(`[trc=${traceId}] ✗ ${msg} sig=${currentSig.slice(0, 16)}…`);
        await this.markFailed(currentSig, msg);
        this.ws?.emitToUser(config.userId, 'snipe_update', { txHash: currentSig, status: 'failed', error: msg });
        return;
      }
    })().catch((e) => this.logger.error(`[trc=${traceId}] monitorWithRetry crashed: ${e?.message}`));
  }

  // ── Confirmation polling ─────────────────────────────────────────────────────

  private async waitForStatus(conn: Connection, sig: string, traceId: string): Promise<ConfirmStatus> {
    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(CONFIRM_POLL_INTERVAL_MS);
      try {
        const resp = await conn.getSignatureStatuses([sig], { searchTransactionHistory: false });
        const st = resp.value?.[0];
        if (!st) continue; // not yet propagated to RPC

        const landed = st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized';
        if (!landed) continue;

        if (!st.err) return 'confirmed';

        const errStr = JSON.stringify(st.err);
        this.logger.warn(`[trc=${traceId}] on-chain err sig=${sig.slice(0, 16)}… err=${errStr}`);

        // Jupiter custom program error 1 = SlippageToleranceExceeded
        if (errStr.includes('"Custom":1') || errStr.includes('"custom":1')) return 'slippage_failed';
        return 'other_failed';

      } catch { /* RPC hiccup — keep polling */ }
    }
    return 'timeout';
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private async markFailed(txHash: string, msg: string) {
    await this.prisma.snipeTrade.updateMany({
      where: { txHash, status: 'broadcast' },
      data: { status: 'failed', errorMsg: msg.slice(0, 1000) },
    }).catch(() => {});
  }

  private async recordTrade(
    config: CachedSnipeConfig,
    mint: string,
    outAmount: string,
    txHash: string | null,
    groupId: string,
    sourceMsg: string,
    status: string,
    errorMsg?: string,
  ) {
    await this.prisma.snipeTrade.create({
      data: {
        userId: config.userId,
        chain: config.chain,
        mint,
        amountRaw: config.buyAmountRaw,
        txHash,
        outAmount,
        groupId,
        sourceMsg: sourceMsg.slice(0, 500),
        status,
        attempts: 1,
        errorMsg: errorMsg ? errorMsg.slice(0, 1000) : null,
      },
    });
  }

  /**
   * Captures price / mcap / liquidity / SOL-USD at fill time and writes them
   * onto the just-recorded SnipeTrade row. Runs in the background — failures
   * here never affect the snipe path. Targets the row by txHash (unique enough
   * for the broadcast we just sent).
   */
  private async attachBuySnapshot(userId: string, mint: string, txHash: string, traceId: string) {
    if (!this.tokenMeta) return;

    // Birdeye token overview + SOL/USD in parallel.
    const [detail, solPrice] = await Promise.all([
      this.tokenMeta.get(mint).catch(() => null),
      this.coingecko
        ? this.coingecko.price(['solana']).then((r) => r?.solana?.usd ?? null).catch(() => null)
        : Promise.resolve(null),
    ]);

    if (!detail && solPrice === null) return;

    const data: Record<string, number | null> = {};
    if (detail?.priceUsd !== null && detail?.priceUsd !== undefined) data.priceAtBuyUsd = detail.priceUsd;
    if (detail?.marketCap !== null && detail?.marketCap !== undefined) data.mcapAtBuyUsd = detail.marketCap;
    if (detail?.liquidity !== null && detail?.liquidity !== undefined) data.liquidityAtBuyUsd = detail.liquidity;
    if (solPrice !== null) data.solPriceAtBuyUsd = solPrice;

    if (Object.keys(data).length === 0) return;

    await this.prisma.snipeTrade.updateMany({
      where: { userId, mint, txHash, status: 'broadcast' },
      data,
    }).catch((e: any) => {
      this.logger.debug(`[trc=${traceId}] snapshot write failed: ${e?.message}`);
    });
  }
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
