import { Module } from '@nestjs/common';
import { MarketDataService } from './market-data.service';
import { MarketDataController } from './market-data.controller';
import { CoinGeckoProvider } from './providers/coingecko.provider';
import { BirdeyeProvider } from './providers/birdeye.provider';
import { TokenMetadataService } from './token-metadata.service';

@Module({
  providers: [MarketDataService, CoinGeckoProvider, BirdeyeProvider, TokenMetadataService],
  controllers: [MarketDataController],
  exports: [MarketDataService, TokenMetadataService],
})
export class MarketDataModule {}
