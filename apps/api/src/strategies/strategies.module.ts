import { Module } from '@nestjs/common';
import { StrategiesController } from './strategies.controller';
import { StrategyPerformanceService } from './strategy-performance.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [StrategyPerformanceService],
  controllers: [StrategiesController],
  exports: [StrategyPerformanceService],
})
export class StrategiesModule {}
