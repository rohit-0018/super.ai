import { Injectable, Logger, Optional } from '@nestjs/common';
import { VersionedTransaction } from '@solana/web3.js';
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
        mint,
        txHash: sig,
        durationMs,
        amountRaw: config.buyAmountRaw,
        outAmount,
        groupId,
        status: 'broadcast',
        ts: Date.now(),
      });

      return { txHash: sig, outAmount, traceId, durationMs };
    } catch (err: any) {
      const durationMs = Date.now() - t0;
      this.logger.error(`[trc=${traceId}] snipe failed mint=${mint} err=${err.message} duration=${durationMs}ms`);
      this.recordTrade(config, mint, '0', null, groupId, sourceMsg, 'failed').catch(() => {});
      return { txHash: null, outAmount: '0', traceId, durationMs };
    }
  }

  private async recordTrade(
    config: CachedSnipeConfig,
    mint: string,
    outAmount: string,
    txHash: string | null,
    groupId: string,
    sourceMsg: string,
    status: string,
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
      },
    });
  }
}
