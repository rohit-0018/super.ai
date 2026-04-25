import { Injectable, Logger, Optional } from '@nestjs/common';
import { Connection, VersionedTransaction } from '@solana/web3.js';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../ws/realtime.gateway';
import { getJupiterApiBase } from '../common/network-config';
import { SnipeSessionService, CachedSnipeConfig } from './snipe-session.service';
import { newTraceId } from '../common/trace-context';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

export interface SnipeResult {
  txHash: string | null;
  outAmount: string;
  traceId: string;
  durationMs: number;
}

/**
 * Zero-overhead fast path for token sniping.
 *
 * Intentionally bypasses ExecutionService (no security layers, no LLM, no DB
 * before broadcast). All of those add latency that kills snipes.
 *
 * What it DOES:
 *  1. Uses pre-decrypted Keypair from SnipeSessionService (avoids KMS round-trip)
 *  2. Direct HTTP to Jupiter (no circuit breaker)
 *  3. skipPreflight=true (skips simulation RPC call — ~100 ms saved)
 *  4. High priority fee (veryHigh level, capped at 1 000 000 lamports ≈ 0.001 SOL)
 *  5. Sends tx and returns immediately — no confirmTransaction wait
 *  6. Records to DB asynchronously after broadcast
 */
@Injectable()
export class SnipeFastService {
  private readonly logger = new Logger(SnipeFastService.name);

  constructor(
    private prisma: PrismaService,
    private snipeSession: SnipeSessionService,
    @Optional() private ws: RealtimeGateway,
  ) {}

  async execute(
    config: CachedSnipeConfig,
    mint: string,
    groupId: string,
    sourceMsg: string,
  ): Promise<SnipeResult> {
    const t0 = Date.now();
    const traceId = newTraceId();
    const session = this.snipeSession.getSession(config.userId);

    if (!session) {
      this.logger.warn(`[trc=${traceId}] No hot session for user=${config.userId} — skipping ${mint}`);
      return { txHash: null, outAmount: '0', traceId, durationMs: Date.now() - t0 };
    }

    const jupBase = getJupiterApiBase();
    if (jupBase === 'MOCK') {
      this.logger.debug(`[trc=${traceId}] testnet — recording mock snipe for ${mint}`);
      const mockHash = `snipe-mock-${Date.now().toString(36)}`;
      await this.recordTrade(config, mint, '0', mockHash, groupId, sourceMsg, 'confirmed');
      return { txHash: mockHash, outAmount: '0', traceId, durationMs: Date.now() - t0 };
    }

    try {
      // ── Step 1: Jupiter quote ──
      const quoteUrl = new URL(`${jupBase}/quote`);
      quoteUrl.searchParams.set('inputMint', SOL_MINT);
      quoteUrl.searchParams.set('outputMint', mint);
      quoteUrl.searchParams.set('amount', config.buyAmountRaw);
      quoteUrl.searchParams.set('slippageBps', String(config.maxSlippageBps));
      quoteUrl.searchParams.set('onlyDirectRoutes', 'false');
      quoteUrl.searchParams.set('dynamicSlippage', 'true');

      const quoteResp = await fetch(quoteUrl.toString(), { signal: AbortSignal.timeout(5_000) });
      if (!quoteResp.ok) {
        const err = await quoteResp.text();
        throw new Error(`Jupiter quote ${quoteResp.status}: ${err.slice(0, 200)}`);
      }
      const quote = await quoteResp.json();

      // ── Step 2: Jupiter swap tx with aggressive priority fee ──
      const swapResp = await fetch(`${jupBase}/swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: session.address,
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: {
            priorityLevelWithMaxLamports: {
              maxLamports: 1_000_000, // ~0.001 SOL cap
              priorityLevel: 'veryHigh',
            },
          },
        }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!swapResp.ok) {
        const err = await swapResp.text();
        throw new Error(`Jupiter swap ${swapResp.status}: ${err.slice(0, 200)}`);
      }
      const { swapTransaction } = await swapResp.json();

      // ── Step 3: Sign ──
      const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
      tx.sign([session.keypair]);
      const rawTx = tx.serialize();

      // ── Step 4: Broadcast (fire and forget — no confirmation wait) ──
      const sig = await session.connection.sendRawTransaction(rawTx, {
        skipPreflight: true,   // skip simulation = ~100 ms saved
        maxRetries: 2,
      });

      const durationMs = Date.now() - t0;
      this.logger.log(`[trc=${traceId}] ⚡ snipe broadcast mint=${mint} sig=${sig} duration=${durationMs}ms`);

      // Record async — never block the hot path
      const outAmount: string = quote.outAmount ?? '0';
      this.recordTrade(config, mint, outAmount, sig, groupId, sourceMsg, 'broadcast').catch((e) =>
        this.logger.warn(`[trc=${traceId}] record failed: ${e.message}`),
      );

      // Emit real-time event to web UI
      this.ws?.emitToUser(config.userId, 'snipe_triggered', {
        mint, txHash: sig, durationMs,
        amountRaw: config.buyAmountRaw, outAmount,
        groupId, status: 'broadcast', ts: Date.now(),
      });

      // Background: poll for on-chain confirmation and update status
      this.confirmInBackground(session.connection, config.userId, sig, traceId);

      return { txHash: sig, outAmount, traceId, durationMs };
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
  }

  /**
   * Polls Solana for tx confirmation for up to 90 s, then updates the DB record
   * and emits a WS event so the UI refreshes without user action.
   *
   * Common failure: wallet has 0 SOL → tx is accepted by RPC but dropped by
   * validators. Solscan never sees it. We detect this via a 90 s timeout and
   * mark the trade failed with a helpful message.
   */
  private confirmInBackground(connection: Connection, userId: string, sig: string, traceId: string): void {
    (async () => {
      const deadline = Date.now() + 90_000;
      let attempts = 0;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, attempts < 5 ? 3_000 : 6_000));
        attempts++;
        try {
          const resp = await connection.getSignatureStatuses([sig], { searchTransactionHistory: true });
          const status = resp.value?.[0];
          if (!status) continue; // not yet indexed

          const errInfo = status.err ? JSON.stringify(status.err) : null;
          const landed = status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized';

          if (landed && !errInfo) {
            this.logger.log(`[trc=${traceId}] ✓ confirmed sig=${sig.slice(0, 16)}…`);
            await this.prisma.snipeTrade.updateMany({
              where: { txHash: sig, status: 'broadcast' },
              data: { status: 'confirmed' },
            });
            this.ws?.emitToUser(userId, 'snipe_update', { txHash: sig, status: 'confirmed' });
            return;
          }

          if (errInfo) {
            const msg = `On-chain failure: ${errInfo}`;
            this.logger.warn(`[trc=${traceId}] ✗ tx failed on-chain sig=${sig.slice(0, 16)}… err=${errInfo}`);
            await this.prisma.snipeTrade.updateMany({
              where: { txHash: sig, status: 'broadcast' },
              data: { status: 'failed', errorMsg: msg },
            });
            this.ws?.emitToUser(userId, 'snipe_update', { txHash: sig, status: 'failed', error: msg });
            return;
          }
        } catch { /* RPC hiccup — retry */ }
      }

      // Timeout — tx was never indexed (almost always = dropped due to 0 SOL balance)
      const msg = 'Transaction dropped — wallet likely has insufficient SOL for fees. Fund the wallet and try again.';
      this.logger.warn(`[trc=${traceId}] ✗ tx timed out sig=${sig.slice(0, 16)}…`);
      await this.prisma.snipeTrade.updateMany({
        where: { txHash: sig, status: 'broadcast' },
        data: { status: 'failed', errorMsg: msg },
      });
      this.ws?.emitToUser(userId, 'snipe_update', { txHash: sig, status: 'failed', error: msg });
    })().catch(() => {});
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
        errorMsg: errorMsg ? errorMsg.slice(0, 1000) : null,
      },
    });
  }
}
