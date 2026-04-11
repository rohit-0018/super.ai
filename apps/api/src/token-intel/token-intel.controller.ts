import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Chain } from '@prisma/client';
import { IsEnum, IsString } from 'class-validator';
import { TokenIntelService } from './token-intel.service';

class AnalyzeDto {
  @IsEnum(Chain) chain!: Chain;
  @IsString() address!: string;
}

@Controller('token-intel')
export class TokenIntelController {
  constructor(private svc: TokenIntelService) {}

  @Get(':chain/:address')
  get(@Param('chain') chain: Chain, @Param('address') address: string) {
    return this.svc.analyze(chain, address);
  }

  @Post('analyze')
  analyze(@Body() dto: AnalyzeDto) {
    return this.svc.analyze(dto.chain, dto.address);
  }
}
