import { forwardRef, Module } from '@nestjs/common';
import { AiAgentService } from './ai-agent.service';
import { AiAgentController } from './ai-agent.controller';
import { LlmService } from './llm.service';
import { ConversationMemoryService } from './conversation-memory.service';
import { TradingDnaService } from './trading-dna.service';
import { ToolExecutorService } from './tool-executor.service';
import { AuthModule } from '../auth/auth.module';
import { ExecutionModule } from '../execution/execution.module';
import { TokenIntelModule } from '../token-intel/token-intel.module';
import { AgentsModule } from '../agents/agents.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { EpisodesModule } from '../episodes/episodes.module';
import { ConvictionLearnerService } from './conviction-learner.service';

@Module({
  imports: [
    AuthModule,
    forwardRef(() => ExecutionModule),
    forwardRef(() => TokenIntelModule),
    forwardRef(() => AgentsModule),
    AnalyticsModule,
    forwardRef(() => EpisodesModule),
  ],
  providers: [AiAgentService, LlmService, ConversationMemoryService, TradingDnaService, ToolExecutorService, ConvictionLearnerService],
  controllers: [AiAgentController],
  exports: [AiAgentService, TradingDnaService, ConversationMemoryService, LlmService, ConvictionLearnerService],
})
export class AiAgentModule {}
