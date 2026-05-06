import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { TokenAnalysisService } from '../token-analysis/token-analysis.service';
import { RealtimeGateway } from '../ws/realtime.gateway';
import type { HotToken } from './hot-tokens.types';
import type { AiVerdict } from '../token-analysis/token-analysis.types';

// ── env config ────────────────────────────────────────────────────────────────
const PIPELINE_ENABLED     = process.env.SIGNAL_PIPELINE_ENABLED !== 'false';
const PIPELINE_DELAY_MS    = parseInt(process.env.PIPELINE_DELAY_MS    ?? '2500',  10);
const BATCH_DELAY_MS       = parseInt(process.env.BATCH_PIPELINE_DELAY_MS ?? '800', 10);
const STRONG_BUY_THRESHOLD = parseInt(process.env.STRONG_BUY_THRESHOLD ?? '78',    10);
const ANALYSIS_TTL_MS      = parseInt(process.env.PIPELINE_CACHE_MIN   ?? '10',    10) * 60_000;
const MAX_QUEUE             = 25;

export interface SignalResult {
  address:        string;
  symbol:         string;
  name:           string;
  chain:          'SOLANA' | 'EVM';
  priceUsd:       number;
  marketCapUsd?:  number;
  score:          number;
  verdict:        AiVerdict;
  profileKey:     string;
  // Exit levels computed from TradingStrategy
  entryPriceUsd:     number;
  t1PriceUsd?:       number;
  t1Pct?:            number;
  t2PriceUsd?:       number;
  t2Pct?:            number;
  stopLossPriceUsd?: number;
  stopLossPct?:      number;
  holdRange?:        string;
  maxHoldMs?:        number;
  riskReward?:       number;
  // Analysis detail
  bullishSignals: string[];
  riskFactors:    string[];
  aiSummary:      string;
  exitSizing?:    string;
  // Meta
  analyzedAt: string;
  dexUrl?:    string;
}

interface QueueItem {
  address:        string;
  symbol:         string;
  heuristicScore: number;
  profileKey:     string;
  /** true = frontend-requested; use shorter inter-item delay */
  fastPath?:      boolean;
}

@Injectable()
export class SignalPipelineService implements OnModuleInit, OnModuleDestroy {
  private readonly logger  = new Logger(SignalPipelineService.name);
  private queue: QueueItem[] = [];
  private processing  = false;
  private destroyed   = false;

  // address → expiry timestamp (no Redis round-trips in hot path)
  private readonly doneCache = new Map<string, number>();
  // address → latest signal result
  private readonly results   = new Map<string, SignalResult>();

  constructor(
    private readonly tokenAnalysis: TokenAnalysisService,
    private readonly realtime:      RealtimeGateway,
  ) {}

  onModuleInit() {
    if (PIPELINE_ENABLED) {
      this.logger.log(
        `Signal pipeline ready — delay=${PIPELINE_DELAY_MS}ms threshold=${STRONG_BUY_THRESHOLD}`,
      );
    } else {
      this.logger.log('Signal pipeline DISABLED (SIGNAL_PIPELINE_ENABLED=false)');
    }
  }

  onModuleDestroy() { this.destroyed = true; }

  // ── public API ─────────────────────────────────────────────────────────────

  /**
   * Called after every hot-tokens scan. Tokens not yet analyzed jump to the
   * front of the queue, sorted by descending heuristic score so the strongest
   * candidates get full AI analysis first.
   */
  enqueue(tokens: HotToken[]): void {
    if (!PIPELINE_ENABLED) return;

    const now = Date.now();
    // Evict expired done-cache entries to keep memory bounded
    for (const [addr, exp] of this.doneCache) {
      if (exp < now) this.doneCache.delete(addr);
    }

    const fresh: QueueItem[] = [];
    for (const t of tokens) {
      if (this.doneCache.has(t.address)) continue;
      fresh.push({
        address:        t.address,
        symbol:         t.symbol,
        heuristicScore: t.score,
        profileKey:     t.profileKey,
      });
    }
    if (!fresh.length) return;

    // Remove stale entries for the same addresses, then prepend fresh batch
    const freshAddrs = new Set(fresh.map((f) => f.address));
    this.queue = this.queue.filter((q) => !freshAddrs.has(q.address));
    fresh.sort((a, b) => b.heuristicScore - a.heuristicScore);
    this.queue = [...fresh, ...this.queue].slice(0, MAX_QUEUE);

    this.logger.log(`Queue: +${fresh.length} new → ${this.queue.length} pending`);

    if (!this.processing) void this.processLoop();
  }

  /**
   * Lightweight enqueue for addresses requested directly by the frontend
   * (e.g. hot-feed page load — analyze cards that have no verdict yet).
   * Items already in the done-cache are silently skipped.
   */
  enqueueBatch(items: Array<{ address: string; symbol: string; profileKey?: string }>): number {
    if (!PIPELINE_ENABLED || !items.length) return 0;

    const now = Date.now();
    for (const [addr, exp] of this.doneCache) {
      if (exp < now) this.doneCache.delete(addr);
    }

    const fresh: QueueItem[] = [];
    for (const i of items) {
      if (this.doneCache.has(i.address) || this.results.has(i.address)) continue;
      fresh.push({ address: i.address, symbol: i.symbol, heuristicScore: 50, profileKey: i.profileKey ?? 'meme_hunter', fastPath: true });
    }
    if (!fresh.length) return 0;

    const freshAddrs = new Set(fresh.map((f) => f.address));
    this.queue = this.queue.filter((q) => !freshAddrs.has(q.address));
    this.queue = [...this.queue, ...fresh].slice(0, MAX_QUEUE);

    this.logger.log(`Batch enqueue: +${fresh.length} from frontend`);
    if (!this.processing) void this.processLoop();
    return fresh.length;
  }

  /** All signal results (for REST /hot-tokens/signals and reconnect hydration). */
  getAll(): SignalResult[] {
    return [...this.results.values()].sort((a, b) => b.score - a.score);
  }

  getStrongBuys(): SignalResult[] {
    return this.getAll().filter((r) => r.score >= STRONG_BUY_THRESHOLD);
  }

  // ── processing loop ────────────────────────────────────────────────────────

  private async processLoop(): Promise<void> {
    if (this.processing || this.destroyed) return;
    this.processing = true;

    while (this.queue.length > 0 && !this.destroyed) {
      const item = this.queue.shift()!;
      await this.analyzeOne(item);
      if (this.queue.length > 0 && !this.destroyed) {
        await this.sleep(item.fastPath ? BATCH_DELAY_MS : PIPELINE_DELAY_MS);
      }
    }

    this.processing = false;
    this.logger.debug('Pipeline idle');
  }

  private async analyzeOne(item: QueueItem): Promise<void> {
    this.logger.debug(`Analyzing ${item.symbol} (score=${item.heuristicScore})`);
    try {
      const report = await this.tokenAnalysis.analyzeAddress(
        item.address, false, 'hot_tokens_scan',
      );

      // Mark done regardless of outcome — prevents infinite re-queue on bad tokens
      this.doneCache.set(item.address, Date.now() + ANALYSIS_TTL_MS);

      if (!report?.aiReasoning) return;

      const { aiReasoning: ai, meta, tradingStrategy: ts } = report;
      const price = meta.priceUsd ?? 0;
      const t1    = ts?.targets?.[0];
      const t2    = ts?.targets?.[1];

      const result: SignalResult = {
        address:        item.address,
        symbol:         meta.symbol  ?? item.symbol,
        name:           meta.name    ?? item.symbol,
        chain:          meta.chain,
        priceUsd:       price,
        marketCapUsd:   meta.marketCapUsd,
        score:          ai.score,
        verdict:        ai.verdict,
        profileKey:     item.profileKey,
        // Exit levels
        entryPriceUsd:     price,
        t1PriceUsd:        t1?.price    ?? undefined,
        t1Pct:             t1?.pct      ?? undefined,
        t2PriceUsd:        t2?.price    ?? undefined,
        t2Pct:             t2?.pct      ?? undefined,
        stopLossPriceUsd:  ts?.stopLossPrice  ?? undefined,
        stopLossPct:       ts?.stopLossPct    ?? undefined,
        holdRange:         ts?.maxHoldTime    ?? undefined,
        maxHoldMs:         undefined, // not on TradingStrategy directly
        riskReward:        ts?.riskReward     ?? undefined,
        // Text
        bullishSignals: ai.bullishSignals,
        riskFactors:    ai.riskFactors,
        aiSummary:      ai.summary,
        exitSizing:     ai.exitSizing,
        analyzedAt:     new Date().toISOString(),
        dexUrl:         meta.url,
      };

      this.results.set(item.address, result);

      this.logger.log(
        `Signal: ${result.symbol} → ${result.verdict} ${result.score}/100` +
        (result.t1PriceUsd ? ` T1=${result.t1PriceUsd.toFixed(6)}` : ''),
      );

      // Broadcast to all clients so hot-feed cards can overlay AI verdict
      this.realtime.emitGlobal('signal_analysis', result);

      // Strong signal → trigger banner
      if (ai.score >= STRONG_BUY_THRESHOLD) {
        this.realtime.emitGlobal('signal_alert', result);
        this.logger.log(`🚨 SIGNAL ALERT: ${result.symbol} score=${result.score} T1=${result.t1Pct ?? '?'}%`);
      }
    } catch (err) {
      this.logger.warn(`Pipeline skip ${item.symbol}: ${(err as Error).message}`);
    }
  }

  private sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
}
