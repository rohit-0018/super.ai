import { Module } from '@nestjs/common';
import { PaperTradingService } from './paper-trading.service';
import { PaperTradingController } from './paper-trading.controller';

@Module({
  providers: [PaperTradingService],
  controllers: [PaperTradingController],
  exports: [PaperTradingService],
})
export class PaperTradingModule {}
