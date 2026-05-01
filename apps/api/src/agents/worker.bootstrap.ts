import { forwardRef, Inject, Injectable, Logger, OnModuleInit, OnApplicationShutdown } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Worker } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { ExecutionService } from '../execution/execution.service';
import { MarketDataService } from '../market-data/market-data.service';
import { NotificationsService } from './notifications.service';
import { TelegramService } from '../telegram/telegram.service';
import { connection, makeQueue, QUEUES } from './queues';
import { startDcaWorker } from './dca.worker';
import { startPositionMonitorWorker } from './position-monitor.worker';
import { startCopyTradeWorker } from './copy-trade.worker';
import { startSnipeWorker } from './snipe.worker';
import { startBriefingWorker } from './briefing.worker';
import { startLearningIngestWorker } from './learning-ingest.worker';
import { startStrategyScorerWorker } from './strategy-scorer.worker';
import { startStrategyPerformanceWorker } from './strategy-performance.worker';
import { startAutonomousTraderWorker } from './autonomous-trader.worker';
import { startApprovalExpirerWorker } from '../approvals/approval-expirer.worker';
import { GuardrailsService } from '../guardrails/guardrails.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { startTelegramWorker } from '../telegram/telegram.worker';
import { TradingDnaService } from '../ai-agent/trading-dna.service';
import { LlmService } from '../ai-agent/llm.service';
import { StrategyPerformanceService } from '../strategies/strategy-performance.service';
import { IntentExtractorService } from '../intent/intent-extractor.service';
import { IntentRuleService } from '../intent/intent-rule.service';
import { IntentRuleEnforcer } from '../intent/intent-rule.enforcer';
import { startIntentExtractorWorkers } from '../intent/intent-extractor.worker';
import { ConversationService } from '../conversations/conversation.service';
import { NoteService } from '../conversations/note.service';
import { startConversationSummarizerWorkers } from '../conversations/conversation-summarizer.worker';
import { startNoteExtractorWorkers } from '../conversations/note-extractor.worker';
import { EpisodicMemoryService } from '../episodes/episodic-memory.service';
import { startEpisodeIngestWorker } from '../episodes/episode-ingest.worker';
import { startEpisodeOutcomeWorker } from '../episodes/episode-outcome.worker';
import { TokenIntelService } from '../token-intel/token-intel.service';
import { ConvictionEngine } from '../token-intel/conviction.engine';
import { ConvictionLearnerService } from '../ai-agent/conviction-learner.service';
import { startConvictionLearnerWorker } from './conviction-learner.worker';
import { startHotTokensScanWorker, startHotTokensRefreshWorker } from '../hot-tokens/hot-tokens.worker';
import { HotTokensService } from '../hot-tokens/hot-tokens.service';
import { Bot } from 'grammy';

export interface WorkerDeps {
  prisma: PrismaService;
  execution: ExecutionService;
  marketData: MarketDataService;
  notifications: NotificationsService;
  telegram: TelegramService;
  dna: TradingDnaService;
  llm: LlmService;
}

@Injectable()
export class WorkerBootstrap implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(WorkerBootstrap.name);
  private workers: Worker[] = [];

  // AiAgentModule ↔ AgentsModule is a genuine circular dep: AiAgentModule imports
  // AgentsModule (for NotificationsService) and AgentsModule now needs LlmService
  // + TradingDnaService for the learning workers. forwardRef() alone can't resolve
  // both sides during provider instantiation, so we pull those services via
  // ModuleRef at start() time — after the full graph has finished booting.
  private dna!: TradingDnaService;
  private llm!: LlmService;
  private approvals!: ApprovalsService;
  private strategyPerf!: StrategyPerformanceService;
  private intentExtractor!: IntentExtractorService;
  private intentRules!: IntentRuleService;
  private intentEnforcer!: IntentRuleEnforcer;
  private conversations!: ConversationService;
  private notes!: NoteService;
  private episodic!: EpisodicMemoryService;
  private tokenIntel!: TokenIntelService;
  private conviction!: ConvictionEngine;
  private convictionLearner!: ConvictionLearnerService;
  private hotTokens!: HotTokensService;

  constructor(
    private prisma: PrismaService,
    private execution: ExecutionService,
    private marketData: MarketDataService,
    private notifications: NotificationsService,
    @Inject(forwardRef(() => TelegramService))
    private telegram: TelegramService,
    private guardrails: GuardrailsService,
    // Explicit @Inject required: the forwardRef(TelegramService) above confuses
    // Reflect metadata so TypeScript type inference alone doesn't resolve ModuleRef.
    @Inject(ModuleRef)
    private moduleRef: ModuleRef,
  ) {}

  async onModuleInit() {
    // Default on Render: API + workers + Telegram in ONE process (QWAI_ROLE=all).
    // Scale-out path: set QWAI_ROLE=web on API replicas and QWAI_ROLE=worker on a
    // dedicated pserv so workers do not double-consume inside web instances.
    const role = process.env.QWAI_ROLE ?? 'all';
    if (role === 'web') {
      this.logger.log('QWAI_ROLE=web — skipping worker bootstrap (workers run in a separate pserv)');
      return;
    }
    await this.start();
  }

  async start() {
    // Resolve circular-via-AiAgentModule + ApprovalsModule services only once
    // the graph is live.
    this.dna = this.moduleRef.get(TradingDnaService, { strict: false });
    this.llm = this.moduleRef.get(LlmService, { strict: false });
    this.approvals = this.moduleRef.get(ApprovalsService, { strict: false });
    this.strategyPerf = this.moduleRef.get(StrategyPerformanceService, { strict: false });
    this.intentExtractor = this.moduleRef.get(IntentExtractorService, { strict: false });
    this.intentRules = this.moduleRef.get(IntentRuleService, { strict: false });
    this.intentEnforcer = this.moduleRef.get(IntentRuleEnforcer, { strict: false });
    this.conversations = this.moduleRef.get(ConversationService, { strict: false });
    this.notes = this.moduleRef.get(NoteService, { strict: false });
    this.episodic = this.moduleRef.get(EpisodicMemoryService, { strict: false });
    this.tokenIntel = this.moduleRef.get(TokenIntelService, { strict: false });
    this.conviction = this.moduleRef.get(ConvictionEngine, { strict: false });
    this.convictionLearner = this.moduleRef.get(ConvictionLearnerService, { strict: false });
    this.hotTokens = this.moduleRef.get(HotTokensService, { strict: false });

    const deps: WorkerDeps = {
      prisma: this.prisma,
      execution: this.execution,
      marketData: this.marketData,
      notifications: this.notifications,
      telegram: this.telegram,
      dna: this.dna,
      llm: this.llm,
    };
    this.workers.push(startDcaWorker(deps));
    this.workers.push(startPositionMonitorWorker(deps));
    this.workers.push(startCopyTradeWorker(deps));
    this.workers.push(startSnipeWorker(deps));
    this.workers.push(startBriefingWorker(deps));
    this.workers.push(startLearningIngestWorker({ ...deps, dna: this.dna }));
    this.workers.push(startStrategyScorerWorker({ ...deps, dna: this.dna, llm: this.llm, strategyPerf: this.strategyPerf }));
    this.workers.push(startStrategyPerformanceWorker({ ...deps, strategyPerf: this.strategyPerf }));
    this.workers.push(startAutonomousTraderWorker({
      ...deps,
      dna: this.dna,
      llm: this.llm,
      guardrails: this.guardrails,
      approvals: this.approvals,
      intentRules: this.intentRules,
      intentEnforcer: this.intentEnforcer,
      episodic: this.episodic,
      conviction: this.conviction,
      tokenIntel: this.tokenIntel,
    }));
    this.workers.push(startApprovalExpirerWorker(this.prisma));

    // L4 intent memory: two extractors + daily stale-retire. Each short-circuits
    // when INTENT_MEMORY_ENABLED !== 'true' so enabling is an env flip with no code push.
    for (const w of startIntentExtractorWorkers({
      ...deps,
      extractor: this.intentExtractor,
      rules: this.intentRules,
    })) {
      this.workers.push(w);
    }

    // L6 conversational memory: idle-sweep + summarize + note-extract + retire.
    // All gated on CHAT_MEMORY_ENABLED inside the workers themselves.
    for (const w of startConversationSummarizerWorkers({ ...deps, conversations: this.conversations, llm: this.llm })) {
      this.workers.push(w);
    }
    for (const w of startNoteExtractorWorkers({ ...deps, notes: this.notes, llm: this.llm })) {
      this.workers.push(w);
    }

    // L2 episodic memory: ingest (post-swap + post-approval) + outcome tick.
    // Both short-circuit on EPISODIC_MEMORY_ENABLED inside the workers.
    this.workers.push(startEpisodeIngestWorker({ ...deps, episodic: this.episodic, tokenIntel: this.tokenIntel, llm: this.llm }));
    this.workers.push(startEpisodeOutcomeWorker({ ...deps, tokenIntel: this.tokenIntel }));

    // L5 conviction learner — per-user weight updates every 6h (or milestone).
    this.workers.push(startConvictionLearnerWorker({ ...deps, learner: this.convictionLearner }));

    // Hot tokens scanner — discovery every 10 min + optional 10-sec price refresh.
    if (this.hotTokens) {
      this.workers.push(startHotTokensScanWorker(this.hotTokens));
      if (this.hotTokens.fastScan) {
        this.workers.push(startHotTokensRefreshWorker(this.hotTokens));
      }
    }

    // Telegram outbound sender — reuse the same Grammy Bot instance owned by
    // TelegramService when available; fall back to a bare instance if we
    // only have a token (e.g. worker-only process without inbound handling).
    const tgBot = this.telegram.getBot();
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (tgBot) {
      this.workers.push(startTelegramWorker({ bot: tgBot }));
    } else if (token) {
      this.workers.push(startTelegramWorker({ bot: new Bot(token) }));
    } else {
      this.logger.warn('Skipping telegram-send worker: no bot instance and no TELEGRAM_BOT_TOKEN.');
    }

    await this.registerRepeatables();
    this.logger.log(`Started ${this.workers.length} BullMQ workers`);
  }

  /**
   * Register repeatable jobs. BullMQ dedupes by repeat key, safe on restarts.
   * - DCA tick every 5 min — worker decides whether each agent is due.
   * - Position monitor every 30 s — polls open trigger orders.
   * - Briefing scheduler every 15 min — fans out per-user briefing jobs at local 08:00.
   */
  private async registerRepeatables() {
    // Repeatable jobs DO NOT get a traceId seeded here: BullMQ would reuse
    // the same data clone on every tick, which is the opposite of what we
    // want for tracing. Each worker generates a fresh `newTraceId()` when
    // `job.data.traceId` is absent, so every tick gets its own id.
    const dca = makeQueue(QUEUES.DCA);
    await dca.add('dca-tick', {}, {
      repeat: { pattern: '*/5 * * * *' },
      removeOnComplete: 100,
      removeOnFail: 100,
      jobId: 'dca-tick',
    });

    const monitor = makeQueue(QUEUES.POSITION_MONITOR);
    await monitor.add('monitor-tick', {}, {
      repeat: { pattern: '*/30 * * * * *' },
      removeOnComplete: 100,
      removeOnFail: 100,
      jobId: 'monitor-tick',
    });

    const briefing = makeQueue(QUEUES.BRIEFING);
    await briefing.add('briefing-scheduler', {}, {
      repeat: { pattern: '*/15 * * * *' },
      removeOnComplete: 100,
      removeOnFail: 100,
      jobId: 'briefing-scheduler',
    });

    // Strategy scorer every 15 min. Worker filters by learning-enabled users
    // with autonomy > MANUAL; idle otherwise.
    const scorer = makeQueue(QUEUES.STRATEGY_SCORER);
    await scorer.add('scorer-tick', {}, {
      repeat: { pattern: '*/15 * * * *' },
      removeOnComplete: 100,
      removeOnFail: 100,
      jobId: 'scorer-tick',
    });

    // Strategy performance aggregator every 10 min. Cheap aggregation over
    // attributed trades + approval decisions. Feeds the scorer's composite.
    const perf = makeQueue(QUEUES.STRATEGY_PERFORMANCE);
    await perf.add('perf-tick', {}, {
      repeat: { pattern: '*/10 * * * *' },
      removeOnComplete: 100,
      removeOnFail: 100,
      jobId: 'perf-tick',
    });

    // Approval expirer every 30 s — cheap updateMany, no-op when nothing is due.
    const expirer = makeQueue(QUEUES.APPROVAL_EXPIRER);
    await expirer.add('expirer-tick', {}, {
      repeat: { pattern: '*/30 * * * * *' },
      removeOnComplete: 100,
      removeOnFail: 100,
      jobId: 'expirer-tick',
    });

    // Autonomous trader tick every 5 min — cheap filter on LearningConfig.enabled.
    const auto = makeQueue(QUEUES.AUTONOMOUS_TRADER);
    await auto.add('auto-tick', {}, {
      repeat: { pattern: '*/5 * * * *' },
      removeOnComplete: 100,
      removeOnFail: 100,
      jobId: 'auto-tick',
    });

    // L4 retire-stale intent rules once per day at 03:00 UTC.
    const retire = makeQueue(QUEUES.INTENT_RETIRE_STALE);
    await retire.add('intent-retire-tick', {}, {
      repeat: { pattern: '0 3 * * *' },
      removeOnComplete: 10,
      removeOnFail: 10,
      jobId: 'intent-retire-tick',
    });

    // L6 conversation idle-sweep every 5 min.
    const idleSweep = makeQueue(QUEUES.CONVERSATION_IDLE_SWEEP);
    await idleSweep.add('convo-idle-tick', {}, {
      repeat: { pattern: '*/5 * * * *' },
      removeOnComplete: 50,
      removeOnFail: 20,
      jobId: 'convo-idle-tick',
    });

    // L6 note-retire-stale daily at 04:00 UTC.
    const noteRetire = makeQueue(QUEUES.NOTE_RETIRE_STALE);
    await noteRetire.add('note-retire-tick', {}, {
      repeat: { pattern: '0 4 * * *' },
      removeOnComplete: 10,
      removeOnFail: 10,
      jobId: 'note-retire-tick',
    });

    // L2 episode outcome filler every 5 min.
    const outcome = makeQueue(QUEUES.EPISODE_OUTCOME);
    await outcome.add('outcome-tick', {}, {
      repeat: { pattern: '*/5 * * * *' },
      removeOnComplete: 50,
      removeOnFail: 20,
      jobId: 'outcome-tick',
    });

    // L5 conviction learner every 6h. Short-circuits when the env flag is off.
    const learner = makeQueue(QUEUES.CONVICTION_LEARNER);
    await learner.add('learner-tick', {}, {
      repeat: { pattern: '0 */6 * * *' },
      removeOnComplete: 20,
      removeOnFail: 20,
      jobId: 'learner-tick',
    });

    // Hot token scanner — full discovery + score every 10 min.
    if (process.env.HOT_TOKENS_ENABLED !== 'false') {
      const hotScan = makeQueue(QUEUES.HOT_TOKENS_SCAN);
      await hotScan.add('hot-tokens-scan', {}, {
        repeat: { pattern: '*/10 * * * *' },
        removeOnComplete: 20,
        removeOnFail: 20,
        jobId: 'hot-tokens-scan',
      });

      // Optional 10-sec price refresh for the already-discovered hot list.
      if (process.env.HOT_TOKENS_FAST_SCAN === 'true') {
        const hotRefresh = makeQueue(QUEUES.HOT_TOKENS_REFRESH);
        await hotRefresh.add('hot-tokens-refresh', {}, {
          repeat: { every: 10_000 },
          removeOnComplete: 10,
          removeOnFail: 10,
          jobId: 'hot-tokens-refresh',
        });
      }
    }
  }

  async stop() {
    await Promise.all(this.workers.map((w) => w.close()));
    await connection.quit();
  }

  async onApplicationShutdown(signal?: string) {
    this.logger.log(`Shutting down ${this.workers.length} workers (${signal ?? 'shutdown'})`);
    try {
      await this.stop();
    } catch (e) {
      this.logger.error(`Worker shutdown error: ${(e as Error).message}`);
    }
  }
}
