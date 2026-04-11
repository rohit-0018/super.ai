import { Module } from '@nestjs/common';
import { CexService } from './cex.service';
import { CexController } from './cex.controller';
import { WalletsModule } from '../wallets/wallets.module';

@Module({ imports: [WalletsModule], providers: [CexService], controllers: [CexController] })
export class CexModule {}
