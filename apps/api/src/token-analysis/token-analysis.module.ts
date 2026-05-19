import { forwardRef, Module } from '@nestjs/common';
import { TokenAnalysisService } from './token-analysis.service';
import { ComparableTokensService } from './comparable-tokens.service';
import { TokenAnalysisController } from './token-analysis.controller';
import { IntelController } from './intel.controller';
import { DexScreenerProvider } from './providers/dexscreener.provider';
import { GeckoTerminalProvider } from './providers/geckoterminal.provider';
import { HeliusHoldersProvider } from './providers/helius-holders.provider';
import { SocialProvider } from './providers/social.provider';
import { SmartMoneyProvider } from './providers/smart-money.provider';
import { JupiterProvider } from './providers/jupiter.provider';
import { SolanaTrackerProvider } from './providers/solana-tracker.provider';
import { MoralisProvider } from './providers/moralis.provider';
import { BundleCheckerProvider } from './providers/bundle-checker.provider';
import { PumpFunProvider } from './providers/pump-fun.provider';
import { BirdeyeProvider } from './providers/birdeye.provider';
import { DeFiLlamaProvider } from './providers/defillama.provider';
import { EtherscanProvider } from './providers/etherscan.provider';
import { BitqueryProvider } from './providers/bitquery.provider';
import { GmgnProvider } from './providers/gmgn.provider';
import { ArkhamProvider } from './providers/arkham.provider';
import { WaybackProvider } from './providers/wayback.provider';
import { AiReasoner } from './ai-reasoner';
import { LlmService } from '../ai-agent/llm.service';
import { TokenIntelModule } from '../token-intel/token-intel.module';
import { IntelTrackModule } from '../intel-track/intel-track.module';
import { WsModule } from '../ws/ws.module';

@Module({
  imports: [forwardRef(() => TokenIntelModule), IntelTrackModule, WsModule],
  providers: [
    TokenAnalysisService,
    ComparableTokensService,
    // Market data
    DexScreenerProvider,
    GeckoTerminalProvider,
    PumpFunProvider,
    // Holder intelligence
    HeliusHoldersProvider,
    SolanaTrackerProvider,
    MoralisProvider,
    EtherscanProvider,
    // Bundle detection
    BundleCheckerProvider,
    BitqueryProvider,
    // Lifecycle + organic score + price impact
    JupiterProvider,
    BirdeyeProvider,
    DeFiLlamaProvider,
    // Smart money
    GmgnProvider,
    ArkhamProvider,
    // Social
    SocialProvider,
    WaybackProvider,
    SmartMoneyProvider,
    // AI
    LlmService,
    AiReasoner,
  ],
  controllers: [TokenAnalysisController, IntelController],
  exports: [TokenAnalysisService, PumpFunProvider, DexScreenerProvider],
})
export class TokenAnalysisModule {}
