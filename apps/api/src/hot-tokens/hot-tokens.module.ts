import { forwardRef, Module } from '@nestjs/common';
import { HotTokensService } from './hot-tokens.service';
import { HotTokensController } from './hot-tokens.controller';
import { SignalPipelineService } from './signal-pipeline.service';
import { TokenPoolService } from './token-pool.service';
import { WsModule } from '../ws/ws.module';
import { TokenAnalysisModule } from '../token-analysis/token-analysis.module';
import { IntelTrackModule } from '../intel-track/intel-track.module';
import { ExecutionModule } from '../execution/execution.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [WsModule, TokenAnalysisModule, IntelTrackModule, PrismaModule, forwardRef(() => ExecutionModule)],
  providers: [HotTokensService, SignalPipelineService, TokenPoolService],
  controllers: [HotTokensController],
  exports: [HotTokensService, SignalPipelineService, TokenPoolService],
})
export class HotTokensModule {}
