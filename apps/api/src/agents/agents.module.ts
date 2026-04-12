import { forwardRef, Module } from '@nestjs/common';
import { AgentsService } from './agents.service';
import { AgentsController } from './agents.controller';
import { AlertsController } from './alerts.controller';
import { NotificationsService } from './notifications.service';
import { EmotionalIntelService } from './emotional-intel.service';
import { WorkerBootstrap } from './worker.bootstrap';
import { WsModule } from '../ws/ws.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ExecutionModule } from '../execution/execution.module';
import { MarketDataModule } from '../market-data/market-data.module';

@Module({
  imports: [WsModule, PrismaModule, forwardRef(() => ExecutionModule), MarketDataModule],
  providers: [AgentsService, NotificationsService, EmotionalIntelService, WorkerBootstrap],
  controllers: [AgentsController, AlertsController],
  exports: [AgentsService, NotificationsService, EmotionalIntelService],
})
export class AgentsModule {}
