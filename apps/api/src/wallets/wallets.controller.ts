import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { WalletsService } from './wallets.service';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { Chain } from '@prisma/client';

class CreateWalletDto {
  @IsEnum(Chain) chain!: Chain;
  @IsOptional() @IsString() label?: string;
}

@UseGuards(JwtAuthGuard)
@Controller('wallets')
export class WalletsController {
  constructor(private wallets: WalletsService) {}

  @Get() list(@Req() req: any) { return this.wallets.list(req.user.userId); }

  @Post() create(@Req() req: any, @Body() dto: CreateWalletDto) {
    return this.wallets.create(req.user.userId, dto.chain, dto.label);
  }

  @Post(':id/export') export(@Req() req: any, @Param('id') id: string) {
    return this.wallets.exportKey(req.user.userId, id).then((key) => ({ key }));
  }

  @Post(':id/primary') primary(@Req() req: any, @Param('id') id: string) {
    return this.wallets.setPrimary(req.user.userId, id);
  }
}
