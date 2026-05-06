import { Module } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { OnchainAnalyticsService } from './onchain-analytics.service';
import { BacktestingService } from './backtesting.service';
import { SignalAnalyticsService } from './signal-analytics.service';
import { AnalyticsController } from './analytics.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [AnalyticsService, OnchainAnalyticsService, BacktestingService, SignalAnalyticsService],
  controllers: [AnalyticsController],
  exports: [AnalyticsService, OnchainAnalyticsService, BacktestingService, SignalAnalyticsService],
})
export class AnalyticsModule {}
