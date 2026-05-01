import { Module } from '@nestjs/common';
import { HotTokensService } from './hot-tokens.service';
import { HotTokensController } from './hot-tokens.controller';
import { WsModule } from '../ws/ws.module';
import { TokenAnalysisModule } from '../token-analysis/token-analysis.module';

@Module({
  imports: [WsModule, TokenAnalysisModule],
  providers: [HotTokensService],
  controllers: [HotTokensController],
  exports: [HotTokensService],
})
export class HotTokensModule {}
