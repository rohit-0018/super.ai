import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WalletsModule } from '../wallets/wallets.module';
import { WsModule } from '../ws/ws.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { TokenAnalysisModule } from '../token-analysis/token-analysis.module';
import { SnipeSessionService } from './snipe-session.service';
import { SnipeFastService } from './snipe-fast.service';
import { SnipeGroupService } from './snipe-group.service';
import { SnipeSellService } from './snipe-sell.service';
import { SnipeController } from './snipe.controller';
import { TgUserbotService } from './tg-userbot.service';
import { TgAuthService } from './tg-auth.service';
import { TgAuthController } from './tg-auth.controller';
import { HeliusService } from './helius.service';

@Module({
  imports: [PrismaModule, WalletsModule, WsModule, MarketDataModule, forwardRef(() => TokenAnalysisModule)],
  providers: [
    HeliusService,
    SnipeSessionService,
    SnipeFastService,
    SnipeGroupService,
    SnipeSellService,
    TgUserbotService,
    TgAuthService,
  ],
  controllers: [SnipeController, TgAuthController],
  exports: [HeliusService, SnipeSessionService, SnipeFastService, SnipeGroupService, SnipeSellService, TgUserbotService],
})
export class SnipeModule {}
