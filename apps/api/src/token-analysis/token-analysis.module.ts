import { Module } from '@nestjs/common';
import { TokenAnalysisService } from './token-analysis.service';
import { TokenAnalysisController } from './token-analysis.controller';
import { DexScreenerProvider } from './providers/dexscreener.provider';
import { GeckoTerminalProvider } from './providers/geckoterminal.provider';
import { TokenIntelModule } from '../token-intel/token-intel.module';

@Module({
  imports: [TokenIntelModule],
  providers: [TokenAnalysisService, DexScreenerProvider, GeckoTerminalProvider],
  controllers: [TokenAnalysisController],
  exports: [TokenAnalysisService],
})
export class TokenAnalysisModule {}
