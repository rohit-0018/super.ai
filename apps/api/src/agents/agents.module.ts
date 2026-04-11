import { Module } from '@nestjs/common';
import { AgentsService } from './agents.service';
import { AgentsController } from './agents.controller';
import { NotificationsService } from './notifications.service';
import { EmotionalIntelService } from './emotional-intel.service';
import { WorkerBootstrap } from './worker.bootstrap';
import { WsModule } from '../ws/ws.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [WsModule, PrismaModule],
  providers: [AgentsService, NotificationsService, EmotionalIntelService, WorkerBootstrap],
  controllers: [AgentsController],
  exports: [AgentsService, NotificationsService, EmotionalIntelService],
})
export class AgentsModule {}
