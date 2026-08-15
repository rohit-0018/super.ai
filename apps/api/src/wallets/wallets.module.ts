import { Module } from '@nestjs/common';
import { WalletsService } from './wallets.service';
import { WalletsController } from './wallets.controller';
import { KmsService } from './kms.service';
import { BulkWalletService } from './bulk-wallet.service';
import { VenuesCoreModule } from '../venues/venues-core.module';

@Module({
  imports: [VenuesCoreModule],
  providers: [WalletsService, KmsService, BulkWalletService],
  controllers: [WalletsController],
  exports: [WalletsService, KmsService, BulkWalletService],
})
export class WalletsModule {}
