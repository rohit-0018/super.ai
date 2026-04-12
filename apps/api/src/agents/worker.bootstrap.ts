import { Injectable, Logger, OnModuleInit, OnApplicationShutdown } from '@nestjs/common';
import { Worker } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { ExecutionService } from '../execution/execution.service';
import { MarketDataService } from '../market-data/market-data.service';
import { NotificationsService } from './notifications.service';
import { connection, makeQueue, QUEUES } from './queues';
import { startDcaWorker } from './dca.worker';
import { startPositionMonitorWorker } from './position-monitor.worker';
import { startCopyTradeWorker } from './copy-trade.worker';
import { startSnipeWorker } from './snipe.worker';
import { startBriefingWorker } from './briefing.worker';

export interface WorkerDeps {
  prisma: PrismaService;
  execution: ExecutionService;
  marketData: MarketDataService;
  notifications: NotificationsService;
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
  ) {}

  async onModuleInit() {
    // Only start workers in the dedicated worker process to avoid double-consumption.
    if (process.env.QWAI_ROLE && process.env.QWAI_ROLE !== 'worker') return;
    await this.start();
  }

  async start() {
    const deps: WorkerDeps = {
      prisma: this.prisma,
      execution: this.execution,
      marketData: this.marketData,
      notifications: this.notifications,
    };
    this.workers.push(startDcaWorker(deps));
    this.workers.push(startPositionMonitorWorker(deps));
    this.workers.push(startCopyTradeWorker(deps));
    this.workers.push(startSnipeWorker(deps));
    this.workers.push(startBriefingWorker(deps));
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
