import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WalletsModule } from '../wallets/wallets.module';
import { WsModule } from '../ws/ws.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { IntelTrackModule } from '../intel-track/intel-track.module';
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
  // IMPORTANT: do NOT import TokenAnalysisModule here. SnipeModule sits at the
  // far end of a long forwardRef chain (TokenIntel → Agents → Execution →
  // Telegram → Approvals → Snipe). Pulling in TokenAnalysisModule from here
  // closes a circular import that even forwardRef can't resolve cleanly,
  // because TokenIntelModule is the scope root and isn't fully evaluated yet.
  // For track-record capture we use IntelTrackModule directly (no outgoing
  // edges that loop back).
  imports: [PrismaModule, WalletsModule, WsModule, MarketDataModule, IntelTrackModule],
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
