import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../ws/realtime.gateway';

// ── env config ────────────────────────────────────────────────────────────────
const RPC_URL          = process.env.HELIUS_RPC_URL ?? null;
const ENABLED          = process.env.HOLDER_WATCH_ENABLED !== 'false' && !!RPC_URL;
const TICK_MS          = parseInt(process.env.HOLDER_WATCH_TICK_MS   ?? '120000', 10); // 2 min
const BATCH            = parseInt(process.env.HOLDER_WATCH_BATCH      ?? '15', 10);     // max tokens / tick (RPC cap)
const LIVE_ONLY        = process.env.HOLDER_WATCH_LIVE_ONLY === 'true';
const DUMP_DROP_PCT    = parseFloat(process.env.HOLDER_DUMP_DROP_PCT  ?? '35'); // top-10 aggregate balance drop → dump
const CONC_SPIKE_PTS   = parseFloat(process.env.HOLDER_CONC_SPIKE_PTS ?? '15'); // top-10 concentration jump (pts) → warn

interface HolderSnapshot {
  top10Sum:         number;  // summed uiAmount of the 10 largest token accounts
  concentrationPct: number;  // top10Sum / supply * 100
  ts:               number;
}

/**
 * HolderWatchService — throttled on-chain holder monitor (Solana / Helius RPC).
 *
 * On its own slow timer (default every 2 min, capped to BATCH tokens per tick),
 * it pulls the largest token accounts for open positions and compares against
 * the previous snapshot. A sharp drop in the aggregate top-10 balance means a
 * whale/insider is dumping — it raises an `insider_dump` signal the ExitEngine
 * consumes as a danger trigger. This is intentionally OFF the 30s exit hot path
 * so it stays cheap (see [[feedback_llm_cost_minimal]] / [[feedback_low_ai_hot_path]]).
 *
 * NOTE: literal "deposit to a CEX hot wallet" tagging needs per-account owner
 * resolution (extra RPC) or Helius transfer webhooks — documented as a future
 * upgrade. The aggregate-balance-drop signal captures the same economic event
 * (a large holder exiting) without it.
 */
@Injectable()
export class HolderWatchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HolderWatchService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  private readonly snapshots = new Map<string, HolderSnapshot>();      // token → last snapshot
  private readonly signals   = new Map<string, { reason: string; ts: number }>(); // token → pending exit signal

  constructor(
    @Optional() private readonly prisma?:   PrismaService,
    @Optional() private readonly realtime?: RealtimeGateway,
  ) {}

  onModuleInit() {
    if (!ENABLED) {
      this.logger.log(`Holder watch DISABLED (${RPC_URL ? 'HOLDER_WATCH_ENABLED=false' : 'no HELIUS_RPC_URL'})`);
      return;
    }
    this.logger.log(`Holder watch started — tick=${TICK_MS}ms batch=${BATCH} dumpDrop=${DUMP_DROP_PCT}% liveOnly=${LIVE_ONLY}`);
    setTimeout(() => void this.tick(), 20_000); // after warm-up
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Returns and CLEARS any pending exit signal for a token (fire-once). The
   * ExitEngine calls this each tick as a cheap in-memory danger check.
   */
  consumeSignal(token: string): string | null {
    const sig = this.signals.get(token);
    if (!sig) return null;
    this.signals.delete(token);
    return sig.reason;
  }

  // ── loop ──────────────────────────────────────────────────────────────────

  async tick(): Promise<void> {
    if (this.running || !this.prisma) return;
    this.running = true;
    try {
      const tokens = await this.dueTokens();
      for (const token of tokens) {
        await this.checkToken(token).catch((e: Error) =>
          this.logger.warn(`holder check ${token.slice(0, 8)}…: ${e.message}`),
        );
      }
    } catch (err) {
      this.logger.error(`Holder watch tick failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** Distinct Solana tokens of open positions, least-recently-checked first, capped to BATCH. */
  private async dueTokens(): Promise<string[]> {
    const where: any = { side: 'buy', exitAt: null, sellStuck: false, chain: 'SOLANA' };
    if (LIVE_ONLY) where.mode = 'LIVE';
    const rows = await this.prisma!.trade.findMany({
      where,
      select: { tokenOut: true },
      distinct: ['tokenOut'],
      take: 500,
    });
    return rows
      .map((r) => r.tokenOut as string)
      .sort((a, b) => (this.snapshots.get(a)?.ts ?? 0) - (this.snapshots.get(b)?.ts ?? 0))
      .slice(0, BATCH);
  }

  private async checkToken(token: string): Promise<void> {
    const snap = await this.fetchSnapshot(token);
    if (!snap) return;

    const prev = this.snapshots.get(token);
    this.snapshots.set(token, snap);
    if (!prev || prev.top10Sum <= 0) return; // first observation — just seed the baseline

    // Whale/insider dump: aggregate top-10 balance fell sharply since last check.
    const dropPct = ((prev.top10Sum - snap.top10Sum) / prev.top10Sum) * 100;
    if (dropPct >= DUMP_DROP_PCT) {
      this.signals.set(token, { reason: 'insider_dump', ts: Date.now() });
      this.logger.warn(`Insider/whale dump on ${token.slice(0, 8)}… top-10 balance −${dropPct.toFixed(0)}%`);
      this.realtime?.emitGlobal('holder_dump', { token, dropPct, ts: new Date().toISOString() });
      return;
    }

    // Concentration spike: a wallet is accumulating a large share — warn only
    // (not an auto-exit, to avoid false dumps), surfaced for the UI / operator.
    const concJump = snap.concentrationPct - prev.concentrationPct;
    if (concJump >= CONC_SPIKE_PTS) {
      this.logger.log(`Concentration spike on ${token.slice(0, 8)}… +${concJump.toFixed(0)}pts → ${snap.concentrationPct.toFixed(0)}%`);
      this.realtime?.emitGlobal('holder_concentration_spike', { token, concentrationPct: snap.concentrationPct, ts: new Date().toISOString() });
    }
  }

  private async fetchSnapshot(mint: string): Promise<HolderSnapshot | null> {
    const [largest, supplyRes] = await Promise.allSettled([
      this.rpc('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }]),
      this.rpc('getTokenSupply',          [mint, { commitment: 'confirmed' }]),
    ]);
    const accounts: Array<{ uiAmount: number | null }> =
      largest.status === 'fulfilled' ? (largest.value?.value ?? []) : [];
    const supply: number | null =
      supplyRes.status === 'fulfilled' ? (supplyRes.value?.value?.uiAmount ?? null) : null;

    if (!accounts.length) return null;
    const top10Sum = accounts.slice(0, 10).reduce((s, a) => s + (a.uiAmount ?? 0), 0);
    const concentrationPct = supply && supply > 0 ? Math.min(100, (top10Sum / supply) * 100) : 0;
    return { top10Sum, concentrationPct, ts: Date.now() };
  }

  private async rpc(method: string, params: unknown[]): Promise<any> {
    const res = await fetch(RPC_URL!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`Helius RPC ${method} returned ${res.status}`);
    const body = await res.json();
    if (body.error) throw new Error(`Helius RPC ${method} error: ${JSON.stringify(body.error)}`);
    return body.result;
  }
}
