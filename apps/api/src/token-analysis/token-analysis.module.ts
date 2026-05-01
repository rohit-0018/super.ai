import { Module } from '@nestjs/common';
import { TokenAnalysisService } from './token-analysis.service';
import { TokenAnalysisController } from './token-analysis.controller';
import { IntelController } from './intel.controller';
import { DexScreenerProvider } from './providers/dexscreener.provider';
import { GeckoTerminalProvider } from './providers/geckoterminal.provider';
import { HeliusHoldersProvider } from './providers/helius-holders.provider';
import { SocialProvider } from './providers/social.provider';
import { SmartMoneyProvider } from './providers/smart-money.provider';
import { AiReasoner } from './ai-reasoner';
import { LlmService } from '../ai-agent/llm.service';
import { TokenIntelModule } from '../token-intel/token-intel.module';

@Module({
  imports: [TokenIntelModule],
  providers: [
    TokenAnalysisService,
    DexScreenerProvider,
    GeckoTerminalProvider,
    HeliusHoldersProvider,
    SocialProvider,
    SmartMoneyProvider,
    LlmService,  // shared — one instance per module, no circular dep
    AiReasoner,
  ],
  controllers: [TokenAnalysisController, IntelController],
  exports: [TokenAnalysisService],
})
export class TokenAnalysisModule {}
