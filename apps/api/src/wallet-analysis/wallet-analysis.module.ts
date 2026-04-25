import { Module } from '@nestjs/common';
import { WalletAnalysisService } from './wallet-analysis.service';
import { WalletAnalysisController } from './wallet-analysis.controller';

@Module({
  providers: [WalletAnalysisService],
  controllers: [WalletAnalysisController],
  exports: [WalletAnalysisService],
})
export class WalletAnalysisModule {}
