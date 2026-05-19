import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { HotTokensModule } from '../hot-tokens/hot-tokens.module';
import { WsModule } from '../ws/ws.module';
import { TokenResolverModule } from '../token-resolver/token-resolver.module';
import { AutoTradeService } from './auto-trade.service';
import { AutoTradePickerService } from './auto-trade-picker.service';
import { AutoTradeWatcherService } from './auto-trade-watcher.service';
import { AutoTradeController } from './auto-trade.controller';

/**
 * Auto-trade engine. One engine for both PAPER and LIVE modes (live wiring
 * deferred). Never touches KMS or real execution paths in v1.
 * See memory: project_auto_trade_engine.md
 */
@Module({
  imports: [PrismaModule, HotTokensModule, WsModule, TokenResolverModule],
  providers: [
    AutoTradeService,
    AutoTradePickerService,
    AutoTradeWatcherService,
  ],
  controllers: [AutoTradeController],
  exports: [AutoTradeService],
})
export class AutoTradeModule {}
