import { forwardRef, Module } from '@nestjs/common';
import { ExitEngineService } from './exit-engine.service';
import { HolderWatchService } from './holder-watch.service';
import { PrismaModule } from '../prisma/prisma.module';
import { HotTokensModule } from '../hot-tokens/hot-tokens.module';
import { WsModule } from '../ws/ws.module';
import { ExecutionModule } from '../execution/execution.module';

@Module({
  imports: [
    PrismaModule,
    WsModule,
    HotTokensModule,
    forwardRef(() => ExecutionModule),
  ],
  providers: [ExitEngineService, HolderWatchService],
  exports: [ExitEngineService],
})
export class ExitEngineModule {}
