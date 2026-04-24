import { forwardRef, Module } from '@nestjs/common';
import { ApprovalsService } from './approvals.service';
import { ApprovalsController } from './approvals.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { WsModule } from '../ws/ws.module';
import { AgentsModule } from '../agents/agents.module';
import { TelegramModule } from '../telegram/telegram.module';

@Module({
  imports: [
    PrismaModule,
    WsModule,
    forwardRef(() => AgentsModule),
    forwardRef(() => TelegramModule),
  ],
  providers: [ApprovalsService],
  controllers: [ApprovalsController],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
