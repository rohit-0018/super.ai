import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ExecutionModule } from '../execution/execution.module';
import { VenuesController } from './venues.controller';
import { VenuesCoreModule } from './venues-core.module';
import { MultiChainFeedService } from './multi-chain-feed.service';
import { TradeRouterService } from './trade-router.service';
import { PerpsMarketService } from './perps/perps-market.service';
import { HyperliquidAdapter } from './perps/hyperliquid.adapter';
import { BinancePerpsAdapter, BybitPerpsAdapter } from './perps/cex-perps.adapter';

/**
 * The multi-chain venue layer: chain registry, cross-chain token feed,
 * chain-agnostic buy/sell routing, and cross-venue perps market data.
 *
 * ExecutionModule is imported with forwardRef because TradeRouterService
 * delegates to ExecutionService, and the execution side already participates
 * in circular wiring with guardrails/agents.
 */
@Module({
  imports: [PrismaModule, VenuesCoreModule, forwardRef(() => ExecutionModule)],
  controllers: [VenuesController],
  providers: [
    MultiChainFeedService,
    TradeRouterService,
    HyperliquidAdapter,
    BinancePerpsAdapter,
    BybitPerpsAdapter,
    PerpsMarketService,
  ],
  exports: [
    VenuesCoreModule,
    MultiChainFeedService,
    TradeRouterService,
    PerpsMarketService,
  ],
})
export class VenuesModule {}
