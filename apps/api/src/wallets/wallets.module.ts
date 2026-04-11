import { Module } from '@nestjs/common';
import { WalletsService } from './wallets.service';
import { WalletsController } from './wallets.controller';
import { KmsService } from './kms.service';

@Module({
  providers: [WalletsService, KmsService],
  controllers: [WalletsController],
  exports: [WalletsService, KmsService],
})
export class WalletsModule {}
