import { forwardRef, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { AiAgentModule } from '../ai-agent/ai-agent.module';
import { TelegramBot } from './telegram.bot';
import { TelegramService } from './telegram.service';
import { TelegramController } from './telegram.controller';

/**
 * Folded-in Telegram runtime: Grammy bot + outbound BullMQ queue, all
 * running in the API process (the standalone `apps/telegram-bot` worker is
 * gone). `forwardRef` to AiAgentModule because AiAgentModule → AgentsModule
 * → TelegramModule (for NotificationsService → TelegramService).
 */
@Module({
  imports: [
    PrismaModule,
    AuthModule,
    forwardRef(() => AiAgentModule),
  ],
  providers: [TelegramBot, TelegramService],
  controllers: [TelegramController],
  exports: [TelegramService, TelegramBot],
})
export class TelegramModule {}
