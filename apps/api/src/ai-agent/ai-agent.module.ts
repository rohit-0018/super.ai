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
import { WalletsModule } from '../wallets/wallets.module';
import { ConvictionLearnerService } from './conviction-learner.service';

// TokenAnalysisModule and HotTokensModule are NOT imported here — they both pull
// in TokenIntelModule which already has a forwardRef back to AiAgentModule, creating
// an unresolvable cycle. ToolExecutorService and AiAgentService resolve those two
// services lazily via ModuleRef.get() instead.

@Module({
  imports: [
    AuthModule,
    forwardRef(() => ExecutionModule),
    forwardRef(() => TokenIntelModule),
    forwardRef(() => AgentsModule),
    AnalyticsModule,
    forwardRef(() => EpisodesModule),
    WalletsModule,
  ],
  providers: [
    AiAgentService,
    LlmService,
    ConversationMemoryService,
    TradingDnaService,
    ToolExecutorService,
    ConvictionLearnerService,
  ],
  controllers: [AiAgentController],
  exports: [AiAgentService, TradingDnaService, ConversationMemoryService, LlmService, ConvictionLearnerService],
})
export class AiAgentModule {}
