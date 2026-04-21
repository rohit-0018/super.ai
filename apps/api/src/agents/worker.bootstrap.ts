import { forwardRef, Inject, Injectable, Logger, OnModuleInit, OnApplicationShutdown } from '@nestjs/common';
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
import { startTelegramWorker } from '../telegram/telegram.worker';
import { Bot } from 'grammy';

export interface WorkerDeps {
  prisma: PrismaService;
  execution: ExecutionService;
  marketData: MarketDataService;
  notifications: NotificationsService;
  telegram: TelegramService;
}

@Injectable()
export class WorkerBootstrap implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(WorkerBootstrap.name);
  private workers: Worker[] = [];

  constructor(
    private prisma: PrismaService,
    private execution: ExecutionService,
    private marketData: MarketDataService,
    private notifications: NotificationsService,
    @Inject(forwardRef(() => TelegramService))
    private telegram: TelegramService,
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
    const deps: WorkerDeps = {
      prisma: this.prisma,
      execution: this.execution,
      marketData: this.marketData,
      notifications: this.notifications,
      telegram: this.telegram,
    };
    this.workers.push(startDcaWorker(deps));
    this.workers.push(startPositionMonitorWorker(deps));
    this.workers.push(startCopyTradeWorker(deps));
    this.workers.push(startSnipeWorker(deps));
    this.workers.push(startBriefingWorker(deps));

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
