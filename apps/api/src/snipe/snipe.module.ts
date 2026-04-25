import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WalletsModule } from '../wallets/wallets.module';
import { WsModule } from '../ws/ws.module';
import { SnipeSessionService } from './snipe-session.service';
import { SnipeFastService } from './snipe-fast.service';
import { SnipeGroupService } from './snipe-group.service';
import { SnipeSellService } from './snipe-sell.service';
import { SnipeController } from './snipe.controller';
import { TgUserbotService } from './tg-userbot.service';
import { TgAuthService } from './tg-auth.service';
import { TgAuthController } from './tg-auth.controller';

@Module({
  imports: [PrismaModule, WalletsModule, WsModule],
  providers: [
    SnipeSessionService,
    SnipeFastService,
    SnipeGroupService,
    SnipeSellService,
    TgUserbotService,
    TgAuthService,
  ],
  controllers: [SnipeController, TgAuthController],
  exports: [SnipeSessionService, SnipeFastService, SnipeGroupService, SnipeSellService, TgUserbotService],
})
export class SnipeModule {}
