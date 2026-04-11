import { Module } from '@nestjs/common';
import { AiAgentService } from './ai-agent.service';
import { AiAgentController } from './ai-agent.controller';
import { LlmService } from './llm.service';
import { ConversationMemoryService } from './conversation-memory.service';
import { TradingDnaService } from './trading-dna.service';

@Module({
  providers: [AiAgentService, LlmService, ConversationMemoryService, TradingDnaService],
  controllers: [AiAgentController],
  exports: [AiAgentService, TradingDnaService, ConversationMemoryService, LlmService],
})
export class AiAgentModule {}
