import { Global, Module } from '@nestjs/common';
import { LiveTradeGuardService } from './live-trade-guard.service';
import { PrismaModule } from '../prisma/prisma.module';

/**
 * Global module so LiveTradeGuardService is a true singleton.
 * Both ExecutionModule and WalletsModule depend on it, and the in-memory
 * rate-limit windows must be shared across them.
 */
@Global()
@Module({
  imports: [PrismaModule],
  providers: [LiveTradeGuardService],
  exports: [LiveTradeGuardService],
})
export class LiveGuardModule {}
