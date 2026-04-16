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
import { MarketDataModule } from '../market-data/market-data.module';

@Module({
  imports: [
    AuthModule,
    forwardRef(() => ExecutionModule),
    forwardRef(() => TokenIntelModule),
    forwardRef(() => AgentsModule),
    AnalyticsModule,
    MarketDataModule,
    // GuardrailsModule is @Global so no need to import
  ],
  providers: [AiAgentService, LlmService, ConversationMemoryService, TradingDnaService, ToolExecutorService],
  controllers: [AiAgentController],
  exports: [AiAgentService, TradingDnaService, ConversationMemoryService, LlmService],
})
export class AiAgentModule {}
