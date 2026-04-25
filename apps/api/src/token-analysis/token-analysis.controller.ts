import { Controller, Get, Param } from '@nestjs/common';
import { TokenAnalysisService } from './token-analysis.service';
import type { Chain } from './token-analysis.types';

@Controller('token-analysis')
export class TokenAnalysisController {
  constructor(private svc: TokenAnalysisService) {}

  /**
   * GET /token-analysis/:chain/:address
   * chain: SOLANA | EVM
   * Returns a TokenAnalysisReport with 4 playbook verdicts.
   * Public — no auth required (helps landing page / unauthenticated scouting).
   */
  @Get(':chain/:address')
  analyze(@Param('chain') chain: string, @Param('address') address: string) {
    const c = chain.toUpperCase() as Chain;
    return this.svc.analyze(c, address);
  }
}
