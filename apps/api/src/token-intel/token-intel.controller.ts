import { Controller, Get, Param } from '@nestjs/common';
import { Chain } from '@prisma/client';
import { TokenIntelService } from './token-intel.service';

@Controller('tokens')
export class TokenIntelController {
  constructor(private svc: TokenIntelService) {}
  @Get(':chain/:address')
  analyze(@Param('chain') chain: Chain, @Param('address') address: string) {
    return this.svc.analyze(chain, address);
  }
}
