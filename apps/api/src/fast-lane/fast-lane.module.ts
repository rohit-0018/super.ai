import { forwardRef, Module, Global } from '@nestjs/common';
import { ExecutionModule } from '../execution/execution.module';
import { AuthModule } from '../auth/auth.module';
import { AgentsModule } from '../agents/agents.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { FastLaneService } from './fast-lane.service';
import { FastLaneController } from './fast-lane.controller';

// ── Optimization services ──
import { UndiciHttpService } from './undici-http.service';
import { ConnectionPrewarmerService } from './connection-prewarmer.service';
import { JitoClient } from './jito.client';
import { ParallelRpcClient } from './parallel-rpc.client';
import { PriorityFeeService } from './priority-fee.service';
import { PriceCacheService } from './price-cache.service';

@Global()
@Module({
  imports: [
    forwardRef(() => ExecutionModule),
    AuthModule,
    forwardRef(() => AgentsModule),
    MarketDataModule,
  ],
  providers: [
    FastLaneService,
    UndiciHttpService,
    ConnectionPrewarmerService,
    JitoClient,
    ParallelRpcClient,
    PriorityFeeService,
    PriceCacheService,
  ],
  controllers: [FastLaneController],
  exports: [
    FastLaneService,
    UndiciHttpService,
    JitoClient,
    ParallelRpcClient,
    PriorityFeeService,
    PriceCacheService,
  ],
})
export class FastLaneModule {}
