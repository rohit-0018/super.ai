import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
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
// Score delta or category change that triggers a verdict_change WS event
const VERDICT_CHANGE_THRESHOLD = 15;
// How many recent verdicts to load on startup (one per address, most recent first)
const HYDRATE_LIMIT = 500;

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

export type VerdictSource = 'scanner_auto' | 'page_load_batch' | 'manual_request';

interface QueueItem {
  address:        string;
  symbol:         string;
  heuristicScore: number;
  profileKey:     string;
  /** true = frontend-requested; use shorter inter-item delay */
  fastPath?:      boolean;
}

/** Bucket verdicts into 3 categories for change detection */
function verdictCategory(v: AiVerdict): 'positive' | 'neutral' | 'negative' {
  if (v === 'STRONG_BUY' || v === 'BUY') return 'positive';
  if (v === 'HIGH_RISK') return 'negative';
  return 'neutral'; // CAUTIOUS | SKIP
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
    @Optional() private readonly realtime: RealtimeGateway,
    @Optional() private readonly prisma:   PrismaService,
  ) {}

  async onModuleInit() {
    if (PIPELINE_ENABLED) {
      this.logger.log(
        `Signal pipeline ready — delay=${PIPELINE_DELAY_MS}ms threshold=${STRONG_BUY_THRESHOLD}`,
      );
      await this.hydrateFromDb();
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

  getResult(address: string): SignalResult | undefined {
    return this.results.get(address);
  }

  // ── DB hydration on startup ────────────────────────────────────────────────

  /**
   * Loads the most recent verdict per address from VerdictHistory so the
   * in-memory results map is populated immediately on restart. Tokens whose
   * last verdict is within the TTL are also marked in doneCache so they're
   * not immediately re-queued — they'll be re-analyzed once the TTL expires.
   */
  private async hydrateFromDb(): Promise<void> {
    if (!this.prisma) return;
    try {
      const rows = await this.prisma.verdictHistory.findMany({
        orderBy: { analyzedAt: 'desc' },
        take: HYDRATE_LIMIT,
        distinct: ['address'],
      });

      const now = Date.now();
      let loaded = 0;

      for (const row of rows) {
        if (this.results.has(row.address)) continue; // don't overwrite live-analysis results

        const result: SignalResult = {
          address:        row.address,
          symbol:         row.symbol  ?? row.address.slice(0, 6),
          name:           row.name    ?? row.symbol ?? row.address.slice(0, 6),
          chain:          (row.chain as 'SOLANA' | 'EVM'),
          priceUsd:       row.priceUsd,
          marketCapUsd:   row.marketCapUsd ?? undefined,
          score:          row.aiScore,
          verdict:        row.aiVerdict as AiVerdict,
          profileKey:     row.profileKey ?? 'meme_hunter',
          entryPriceUsd:  row.priceUsd,
          t1Pct:          row.t1Pct      ?? undefined,
          t2Pct:          row.t2Pct      ?? undefined,
          stopLossPct:    row.stopLossPct ?? undefined,
          riskReward:     row.riskReward  ?? undefined,
          bullishSignals: Array.isArray(row.bullishSignals) ? (row.bullishSignals as string[]) : [],
          riskFactors:    Array.isArray(row.riskFactors)    ? (row.riskFactors    as string[]) : [],
          aiSummary:      row.aiSummary ?? '',
          analyzedAt:     row.analyzedAt.toISOString(),
        };

        this.results.set(row.address, result);

        // Only skip re-analysis if verdict is still fresh
        const age = now - row.analyzedAt.getTime();
        if (age < ANALYSIS_TTL_MS) {
          this.doneCache.set(row.address, row.analyzedAt.getTime() + ANALYSIS_TTL_MS);
        }

        loaded++;
      }

      this.logger.log(`Hydrated ${loaded} signal results from DB (${rows.length} rows scanned)`);
    } catch (err) {
      this.logger.warn(`DB hydration failed (starting empty): ${(err as Error).message}`);
    }
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
    const t0 = Date.now();
    try {
      const report = await this.tokenAnalysis.analyzeAddress(
        item.address, false, 'hot_tokens_scan',
      );

      // Mark done regardless of outcome — prevents infinite re-queue on bad tokens
      this.doneCache.set(item.address, Date.now() + ANALYSIS_TTL_MS);

      if (!report?.aiReasoning) return;

      const latencyMs = Date.now() - t0;
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
        maxHoldMs:         undefined,
        riskReward:        ts?.riskReward     ?? undefined,
        // Text
        bullishSignals: ai.bullishSignals,
        riskFactors:    ai.riskFactors,
        aiSummary:      ai.summary,
        exitSizing:     ai.exitSizing,
        analyzedAt:     new Date().toISOString(),
        dexUrl:         meta.url,
      };

      // Detect verdict changes before overwriting the previous result
      const prev = this.results.get(item.address);
      if (prev) {
        const scoreDelta   = result.score - prev.score;
        const categoryChanged = verdictCategory(result.verdict) !== verdictCategory(prev.verdict);
        if (Math.abs(scoreDelta) >= VERDICT_CHANGE_THRESHOLD || categoryChanged) {
          this.realtime?.emitGlobal('verdict_change', {
            address:       result.address,
            symbol:        result.symbol,
            prev:          { score: prev.score,   verdict: prev.verdict },
            current:       { score: result.score, verdict: result.verdict },
            scoreDelta,
            categoryChanged,
          });
          this.logger.log(
            `Verdict shift: ${result.symbol} ${prev.verdict}(${prev.score}) → ${result.verdict}(${result.score}) Δ${scoreDelta > 0 ? '+' : ''}${scoreDelta}`,
          );
        }
      }

      this.results.set(item.address, result);

      this.logger.log(
        `Signal: ${result.symbol} → ${result.verdict} ${result.score}/100` +
        (result.t1PriceUsd ? ` T1=${result.t1PriceUsd.toFixed(6)}` : ''),
      );

      // Persist to DB (fire-and-forget — never blocks the pipeline)
      const source: VerdictSource = item.fastPath ? 'page_load_batch' : 'scanner_auto';
      void this.persistVerdict(result, source, latencyMs);

      // Broadcast to all clients so hot-feed cards can overlay AI verdict
      this.realtime?.emitGlobal('signal_analysis', result);

      // Strong signal → trigger banner
      if (ai.score >= STRONG_BUY_THRESHOLD) {
        this.realtime?.emitGlobal('signal_alert', result);
        this.logger.log(`🚨 SIGNAL ALERT: ${result.symbol} score=${result.score} T1=${result.t1Pct ?? '?'}%`);
      }
    } catch (err) {
      this.logger.warn(`Pipeline skip ${item.symbol}: ${(err as Error).message}`);
    }
  }

  // ── DB persistence ─────────────────────────────────────────────────────────

  private async persistVerdict(result: SignalResult, source: VerdictSource, latencyMs: number): Promise<void> {
    if (!this.prisma) return;
    try {
      await this.prisma.verdictHistory.create({
        data: {
          address:        result.address,
          chain:          result.chain,
          symbol:         result.symbol,
          name:           result.name,
          aiScore:        result.score,
          aiVerdict:      result.verdict,
          priceUsd:       result.priceUsd,
          marketCapUsd:   result.marketCapUsd ?? null,
          t1Pct:          result.t1Pct        ?? null,
          t2Pct:          result.t2Pct        ?? null,
          stopLossPct:    result.stopLossPct   ?? null,
          riskReward:     result.riskReward    ?? null,
          aiSummary:      result.aiSummary,
          bullishSignals: result.bullishSignals,
          riskFactors:    result.riskFactors,
          source,
          profileKey:     result.profileKey,
          latencyMs,
        },
      });
    } catch (err) {
      this.logger.warn(`persistVerdict failed for ${result.symbol}: ${(err as Error).message}`);
    }
  }

  private sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
}
