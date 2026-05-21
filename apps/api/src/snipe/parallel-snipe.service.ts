import { Injectable, Logger, Optional } from '@nestjs/common';
import { RealtimeGateway } from '../ws/realtime.gateway';
import { makeQueue, QUEUES, QueueName } from '../agents/queues';
import { SnipeSessionService } from './snipe-session.service';
import { SnipeFastService } from './snipe-fast.service';

// Heavy recurring queues we pause during a burst so they don't compete for
// RPC bandwidth / event loop time. POSITION_MONITOR stays alive — existing
// stop-losses must still fire while a burst is in flight.
const PAUSE_QUEUES: QueueName[] = [
  QUEUES.HOT_TOKENS_SCAN,
  QUEUES.HOT_TOKENS_REFRESH,
  QUEUES.AUTONOMOUS_TRADER,
  QUEUES.DCA,
  QUEUES.LEARNING_INGEST,
];

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
  status: 'broadcast' | 'failed';
  error?: string;
}

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
    results: BurstResult[];
    durationMs: number;
    paused: string[];
  }> {
    const t0 = Date.now();
    const { userId, mint, buyAmountRaw, maxSlippageBps, pauseWorkers = true } = opts;

    const sessions = this.snipeSession.getBurstSessions(userId);
    if (sessions.length === 0) {
      throw new Error('No active burst sessions — call POST /api/snipe/burst/start first');
    }

    const paused: string[] = [];
    if (pauseWorkers) {
      // Pause is best-effort: a failed pause should never abort the snipe.
      for (const name of PAUSE_QUEUES) {
        try {
          await makeQueue(name).pause();
          paused.push(name);
        } catch (e: any) {
          this.logger.warn(`Failed to pause queue ${name}: ${e?.message}`);
        }
      }
      this.scheduleResume(userId, paused);
    }

    this.ws?.emitToUser(userId, 'burst_snipe_started', {
      mint, walletCount: sessions.length,
      buyAmountRaw, maxSlippageBps, paused, ts: Date.now(),
    });

    const settled = await Promise.allSettled(
      sessions.map((session) =>
        this.snipeFast.executeBurst({
          session, userId, chain: 'SOLANA', mint,
          buyAmountRaw, maxSlippageBps,
        }),
      ),
    );

    const results: BurstResult[] = settled.map((r, i) => {
      if (r.status === 'fulfilled') {
        const v = r.value;
        return {
          walletId: v.walletId, address: v.address,
          txHash: v.txHash, outAmount: v.outAmount,
          durationMs: v.durationMs, traceId: v.traceId,
          status: v.txHash ? 'broadcast' : 'failed',
        };
      }
      const s = sessions[i];
      return {
        walletId: s.walletId, address: s.address,
        txHash: null, outAmount: '0',
        durationMs: Date.now() - t0, traceId: '',
        status: 'failed',
        error: r.reason?.message?.slice(0, 200) ?? 'unknown',
      };
    });

    const durationMs = Date.now() - t0;
    const fired = results.filter((r) => r.status === 'broadcast').length;
    this.logger.log(
      `Burst complete: user=${userId} mint=${mint.slice(0, 8)}… fired=${fired}/${results.length} ${durationMs}ms`,
    );

    this.ws?.emitToUser(userId, 'burst_snipe_complete', {
      mint, fired, total: results.length, durationMs, ts: Date.now(),
    });

    return { fired, results, durationMs, paused };
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
