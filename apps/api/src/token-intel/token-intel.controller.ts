import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Chain } from '@prisma/client';
import { IsEnum, IsString } from 'class-validator';
import { TokenIntelService } from './token-intel.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { EmotionalIntelService } from '../agents/emotional-intel.service';

class AnalyzeDto {
  @IsEnum(Chain) chain!: Chain;
  @IsString() address!: string;
}

@Controller('token-intel')
export class TokenIntelController {
  constructor(
    private svc: TokenIntelService,
    private emotional: EmotionalIntelService,
  ) {}

  @Get(':chain/:address')
  get(@Param('chain') chain: Chain, @Param('address') address: string) {
    return this.svc.analyze(chain, address);
  }

  @UseGuards(JwtAuthGuard)
  @Post('analyze')
  async analyze(@Req() req: any, @Body() dto: AnalyzeDto) {
    if (req.user?.userId) {
      this.emotional.trackTokenView(req.user.userId, dto.address).catch(() => {});
    }
    return this.svc.analyze(dto.chain, dto.address);
  }
}
