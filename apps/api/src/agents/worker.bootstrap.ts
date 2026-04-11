import { Injectable, Logger } from '@nestjs/common';
import { startDcaWorker } from './dca.worker';
import { startPositionMonitorWorker } from './position-monitor.worker';
import { startCopyTradeWorker } from './copy-trade.worker';
import { startSnipeWorker } from './snipe.worker';
import { startBriefingWorker } from './briefing.worker';

@Injectable()
export class WorkerBootstrap {
  private logger = new Logger(WorkerBootstrap.name);
  async start() {
    startDcaWorker();
    startPositionMonitorWorker();
    startCopyTradeWorker();
    startSnipeWorker();
    startBriefingWorker();
    this.logger.log('All BullMQ workers started');
  }
}
