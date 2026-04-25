import { Controller, Get, Param } from '@nestjs/common';
import { WalletAnalysisService } from './wallet-analysis.service';
import type { Chain } from './wallet-analysis.types';

@Controller('wallet-analysis')
export class WalletAnalysisController {
  constructor(private svc: WalletAnalysisService) {}

  /**
   * GET /wallet-analysis/:chain/:address
   * Public endpoint — heuristic trader scorecard + copy-fit verdict.
   */
  @Get(':chain/:address')
  analyze(@Param('chain') chain: string, @Param('address') address: string) {
    const c = chain.toUpperCase() as Chain;
    return this.svc.analyze(c, address);
  }
}
