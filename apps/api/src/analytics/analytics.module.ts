import { Module } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { OnchainAnalyticsService } from './onchain-analytics.service';
import { BacktestingService } from './backtesting.service';
import { AnalyticsController } from './analytics.controller';

@Module({ providers: [AnalyticsService, OnchainAnalyticsService, BacktestingService], controllers: [AnalyticsController], exports: [AnalyticsService, OnchainAnalyticsService, BacktestingService] })
export class AnalyticsModule {}
