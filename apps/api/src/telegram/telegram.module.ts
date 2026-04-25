import { forwardRef, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { AiAgentModule } from '../ai-agent/ai-agent.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { SnipeModule } from '../snipe/snipe.module';
import { TelegramBot } from './telegram.bot';
import { TelegramService } from './telegram.service';
import { TelegramController } from './telegram.controller';

/**
 * Folded-in Telegram runtime: Grammy bot + outbound BullMQ queue, all
 * running in the API process (the standalone `apps/telegram-bot` worker is
 * gone). `forwardRef` to AiAgentModule because AiAgentModule → AgentsModule
 * → TelegramModule (for NotificationsService → TelegramService).
 *
 * SnipeModule is imported so TelegramBot can @Optional() inject SnipeGroupService.
 * No forwardRef needed: SnipeModule does not import TelegramModule.
 */
@Module({
  imports: [
    PrismaModule,
    AuthModule,
    forwardRef(() => AiAgentModule),
    forwardRef(() => ApprovalsModule),
    SnipeModule,
  ],
  providers: [TelegramBot, TelegramService],
  controllers: [TelegramController],
  exports: [TelegramService, TelegramBot],
})
export class TelegramModule {}
