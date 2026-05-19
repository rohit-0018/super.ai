import { Module } from '@nestjs/common';
import { WalletsService } from './wallets.service';
import { WalletsController } from './wallets.controller';
import { KmsService } from './kms.service';
import { SquadsClient } from './squads.client';
import { SafeClient } from './safe.client';

@Module({
  providers: [WalletsService, KmsService, SquadsClient, SafeClient],
  controllers: [WalletsController],
  exports: [WalletsService, KmsService, SquadsClient, SafeClient],
})
export class WalletsModule {}
