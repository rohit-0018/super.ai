import { Module } from '@nestjs/common';
import { MarketDataService } from './market-data.service';
import { MarketDataController } from './market-data.controller';
import { CoinGeckoProvider } from './providers/coingecko.provider';
import { BirdeyeProvider } from './providers/birdeye.provider';

@Module({
  providers: [MarketDataService, CoinGeckoProvider, BirdeyeProvider],
  controllers: [MarketDataController],
  exports: [MarketDataService],
})
export class MarketDataModule {}
