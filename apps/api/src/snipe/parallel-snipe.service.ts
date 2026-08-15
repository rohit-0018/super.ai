import { Injectable, Logger, Optional } from '@nestjs/common';
import { RealtimeGateway } from '../ws/realtime.gateway';
import { makeQueue, QUEUES, QueueName } from '../agents/queues';
import { SnipeSessionService } from './snipe-session.service';
import { SnipeFastService } from './snipe-fast.service';

// Queues that stay alive during a burst.
//   POSITION_MONITOR  — sell worker; existing stop-losses must still fire.
//   TELEGRAM_SEND     — burst summary notification gets posted here; queue
//                       jobs survive the pause anyway, but keeping it alive
//                       means the post-burst ping isn't delayed by 30s.
const KEEP_ALIVE: QueueName[] = [
  QUEUES.POSITION_MONITOR,
  QUEUES.TELEGRAM_SEND,
];

// Everything else gets paused — explicit derivation so adding a new queue
// to QUEUES auto-pauses it during a burst (safer default than allowlist).
const PAUSE_QUEUES: QueueName[] = (Object.values(QUEUES) as QueueName[])
  .filter((q) => !KEEP_ALIVE.includes(q));

// How long the queues stay paused after a burst. The burst itself returns
// in ~100-300 ms, but the background monitor needs the rest of this window
// to confirm on a quiet pipe.
const PAUSE_WINDOW_MS = 30_000;

export interface BurstResult {
  walletId: string;
  address: string;
  txHash: string | null;
  outAmount: string;
  durationMs: number;
  traceId: string;
  status: 'broadcast' | 'failed' | 'skipped';
  error?: string;
}

// Fee headroom (SOL) reserved on top of the buy amount: Jupiter compute fee,
// priority fee, possible ATA rent for the new token account. The actual buy
// for any wallet is `min(configured, balance - FEE_HEADROOM_SOL)`.
const FEE_HEADROOM_SOL = 0.002;
// Floor for a buy worth doing — below this the fee dwarfs the position and
// the wallet skips. 0.005 SOL ≈ $1 buy at current SOL price.
const MIN_BUY_SOL = 0.005;
const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Orchestrates a "burst" snipe: fires the same buy across every Solana wallet
 * the user has hot, in parallel, with optional heavy-worker pause for the
 * duration.
 *
 * Hot path:
 *   1. Read all live burst sessions for the user (must call /session/start-all first).
 *   2. Pause heavy BullMQ queues (best-effort; failures don't block).
 *   3. Promise.allSettled across SnipeFastService.executeBurst per session.
 *   4. Schedule queue resume after PAUSE_WINDOW_MS.
 *   5. Return per-wallet results immediately (background monitor runs on).
 */
@Injectable()
export class ParallelSnipeService {
  private readonly logger = new Logger(ParallelSnipeService.name);

  // userId → timeout handle. Lets a second burst extend the pause window
  // instead of resuming queues mid-snipe.
  private resumeTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private snipeSession: SnipeSessionService,
    private snipeFast: SnipeFastService,
    @Optional() private ws: RealtimeGateway,
  ) {}

  async burst(opts: {
    userId: string;
    mint: string;
    buyAmountRaw: string;
    maxSlippageBps: number;
    pauseWorkers?: boolean;
  }): Promise<{
    fired: number;
    skipped: number;
    results: BurstResult[];
    durationMs: number;
    paused: string[];
  }> {
    const t0 = Date.now();
    const { userId, mint, buyAmountRaw, maxSlippageBps, pauseWorkers = true } = opts;

    const allSessions = this.snipeSession.getBurstSessions(userId);
    if (allSessions.length === 0) {
      throw new Error('No active burst sessions — call POST /api/snipe/burst/start first');
    }

    // Per-wallet auto-sizing. Each wallet fires the *largest* buy it can
    // afford up to the configured amount. So a wallet with 0.05 SOL can
    // still join a "0.1 SOL each" burst — it'll just buy 0.048 SOL.
    //
    // Only wallets that can't even cover MIN_BUY_SOL + fee headroom skip.
    const feeHeadroomLamports = BigInt(Math.round(FEE_HEADROOM_SOL * LAMPORTS_PER_SOL));
    const minBuyLamports      = BigInt(Math.round(MIN_BUY_SOL       * LAMPORTS_PER_SOL));
    const configuredBuy       = BigInt(buyAmountRaw);
    const minTotalLamports    = minBuyLamports + feeHeadroomLamports;

    type Funded = { session: typeof allSessions[number]; perWalletBuyRaw: string };
    const fundedSessions: Funded[] = [];
    const skipped: BurstResult[] = [];
    for (const s of allSessions) {
      const bal = BigInt(s.balanceLamports ?? 0);
      if (bal < minTotalLamports) {
        const haveSol = Number(bal) / LAMPORTS_PER_SOL;
        skipped.push({
          walletId: s.walletId, address: s.address,
          txHash: null, outAmount: '0',
          durationMs: 0, traceId: '',
          status: 'skipped',
          error: `dust balance: ${haveSol.toFixed(4)} SOL (need ≥ ${(MIN_BUY_SOL + FEE_HEADROOM_SOL).toFixed(4)})`,
        });
        continue;
      }
      // Affordable = balance minus fee headroom. Capped at the configured amount.
      const affordable = bal - feeHeadroomLamports;
      const perWalletRaw = affordable < configuredBuy ? affordable : configuredBuy;
      fundedSessions.push({ session: s, perWalletBuyRaw: perWalletRaw.toString() });
    }

    if (fundedSessions.length === 0) {
      this.logger.warn(
        `Burst skipped: user=${userId} mint=${mint.slice(0, 8)}… all ${allSessions.length} wallets underfunded`,
      );
      // Still emit a "complete" event so UI knows the burst ended.
      this.ws?.emitToUser(userId, 'burst_snipe_complete', {
        mint, fired: 0, skipped: skipped.length, total: allSessions.length,
        durationMs: Date.now() - t0, ts: Date.now(),
      });
      return {
        fired: 0, skipped: skipped.length, results: skipped,
        durationMs: Date.now() - t0, paused: [],
      };
    }

    const paused: string[] = [];
    if (pauseWorkers) {
      // Fire-and-forget — Redis roundtrips for ~25 queues add 25-75ms of
      // blocked time before any wallet broadcasts. The snipe's job isn't
      // to wait for the cleanup crew to clock out. Each pause runs in
      // parallel; resume is scheduled now (not after the pause settles)
      // so the timer is anchored to t0, not t0 + pause-rtt.
      for (const name of PAUSE_QUEUES) paused.push(name);
      Promise.allSettled(
        PAUSE_QUEUES.map((name) =>
          makeQueue(name).pause().catch((e: any) => {
            this.logger.warn(`Pause ${name} failed: ${e?.message}`);
          }),
        ),
      );
      this.scheduleResume(userId, paused);
    }

    this.ws?.emitToUser(userId, 'burst_snipe_started', {
      mint, walletCount: fundedSessions.length, skippedCount: skipped.length,
      buyAmountRaw, maxSlippageBps, paused, ts: Date.now(),
    });

    // Surface skipped wallets immediately so the UI grid lights up "skipped"
    // rows alongside the in-flight ones.
    for (const s of skipped) {
      this.ws?.emitToUser(userId, 'burst_snipe_progress', {
        walletId: s.walletId, address: s.address,
        mint, txHash: null, durationMs: 0,
        amountRaw: buyAmountRaw, outAmount: '0',
        status: 'skipped', error: s.error, ts: Date.now(),
      });
    }

    const settled = await Promise.allSettled(
      fundedSessions.map(({ session, perWalletBuyRaw }) =>
        this.snipeFast.executeBurst({
          session, userId, chain: 'SOLANA', mint,
          buyAmountRaw: perWalletBuyRaw, maxSlippageBps,
        }),
      ),
    );

    const broadcastResults: BurstResult[] = settled.map((r, i) => {
      if (r.status === 'fulfilled') {
        const v = r.value;
        return {
          walletId: v.walletId, address: v.address,
          txHash: v.txHash, outAmount: v.outAmount,
          durationMs: v.durationMs, traceId: v.traceId,
          status: v.txHash ? 'broadcast' : 'failed',
        };
      }
      const { session: s } = fundedSessions[i];
      return {
        walletId: s.walletId, address: s.address,
        txHash: null, outAmount: '0',
        durationMs: Date.now() - t0, traceId: '',
        status: 'failed',
        error: r.reason?.message?.slice(0, 200) ?? 'unknown',
      };
    });

    const results = [...broadcastResults, ...skipped];
    const durationMs = Date.now() - t0;
    const fired = broadcastResults.filter((r) => r.status === 'broadcast').length;
    this.logger.log(
      `Burst complete: user=${userId} mint=${mint.slice(0, 8)}… fired=${fired}/${fundedSessions.length} skipped=${skipped.length} ${durationMs}ms`,
    );

    this.ws?.emitToUser(userId, 'burst_snipe_complete', {
      mint, fired, skipped: skipped.length, total: allSessions.length,
      durationMs, ts: Date.now(),
    });

    return { fired, skipped: skipped.length, results, durationMs, paused };
  }

  private scheduleResume(userId: string, paused: string[]) {
    const existing = this.resumeTimers.get(userId);
    if (existing) clearTimeout(existing);
    const handle = setTimeout(() => {
      this.resumeQueues(paused).catch((e) => this.logger.warn(`Resume failed: ${e?.message}`));
      this.resumeTimers.delete(userId);
    }, PAUSE_WINDOW_MS);
    this.resumeTimers.set(userId, handle);
  }

  /**
   * Resume queues immediately. Exposed so the controller can call it from a
   * "/burst/resume" admin endpoint if a burst hangs.
   */
  async resumeQueues(names: string[] = PAUSE_QUEUES as unknown as string[]) {
    for (const name of names) {
      try {
        await makeQueue(name as QueueName).resume();
      } catch (e: any) {
        this.logger.warn(`Failed to resume ${name}: ${e?.message}`);
      }
    }
  }
}
