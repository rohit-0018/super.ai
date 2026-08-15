import { Module } from '@nestjs/common';
import { NativePriceService } from './native-price.service';
import { EvmBalancesService } from './evm-balances.service';
import { DexScreenerClient } from './providers/dexscreener.client';

/**
 * Dependency-free half of the venue layer: chain registry helpers, native
 * pricing, multi-chain EVM balances, and the DexScreener client.
 *
 * Kept separate from VenuesModule so WalletsModule can consume it without a
 * circular import. The full VenuesModule pulls in ExecutionModule, and
 * ExecutionModule already imports WalletsModule — importing that from wallets
 * would close the loop. Nothing in here touches Prisma or execution.
 */
@Module({
  providers: [NativePriceService, EvmBalancesService, DexScreenerClient],
  exports: [NativePriceService, EvmBalancesService, DexScreenerClient],
})
export class VenuesCoreModule {}
