import { forwardRef, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { AiAgentModule } from '../ai-agent/ai-agent.module';
import { ConversationsController } from './conversations.controller';
import { ConversationService } from './conversation.service';
import { NoteService } from './note.service';
import { ConversationalMemoryService } from './conversational-memory.service';

@Module({
  imports: [PrismaModule, AuthModule, forwardRef(() => AiAgentModule)],
  controllers: [ConversationsController],
  providers: [ConversationService, NoteService, ConversationalMemoryService],
  exports: [ConversationService, NoteService, ConversationalMemoryService],
})
export class ConversationsModule {}
