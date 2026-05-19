import { Module } from '@nestjs/common';
import { TokenAnalysisModule } from '../token-analysis/token-analysis.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { TokenResolverService } from './token-resolver.service';
import { TokenResolverController } from './token-resolver.controller';

/**
 * Reusable "raw string → ranked token(s)" resolver. Depends only on the
 * DexScreener + CoinGecko provider singletons (re-used, not re-instantiated)
 * so it carries no analysis/AI weight and can be imported anywhere a contract
 * address is accepted (Telegram, web, trade paths).
 */
@Module({
  imports: [TokenAnalysisModule, MarketDataModule],
  providers: [TokenResolverService],
  controllers: [TokenResolverController],
  exports: [TokenResolverService],
})
export class TokenResolverModule {}
