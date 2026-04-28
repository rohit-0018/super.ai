import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { WalletsService } from './wallets.service';
import { IsEnum, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { Chain } from '@prisma/client';

class CreateWalletDto {
  @IsEnum(Chain) chain!: Chain;
  @IsOptional() @IsString() label?: string;
}

class ImportWalletDto {
  @IsEnum(Chain) chain!: Chain;
  @IsString() privateKey!: string;
  @IsOptional() @IsString() label?: string;
}

class WithdrawDto {
  @IsString() toAddress!: string;
  @IsString() tokenMint!: string;
  @IsNumber() @Min(0) amount!: number;
}

@UseGuards(JwtAuthGuard)
@Controller('wallets')
export class WalletsController {
  constructor(private wallets: WalletsService) {}

  @Get() list(@Req() req: any) { return this.wallets.list(req.user.userId); }

  @Post() create(@Req() req: any, @Body() dto: CreateWalletDto) {
    return this.wallets.create(req.user.userId, dto.chain, dto.label);
  }

  @Post('import') import(@Req() req: any, @Body() dto: ImportWalletDto) {
    return this.wallets.importWallet(req.user.userId, dto.chain, dto.privateKey, dto.label);
  }

  @Post(':id/export') export(@Req() req: any, @Param('id') id: string) {
    return this.wallets.exportKey(req.user.userId, id).then((key) => ({ key }));
  }

  @Post(':id/confirm-backup') confirmBackup(@Req() req: any, @Param('id') id: string) {
    return this.wallets.confirmBackup(req.user.userId, id).then(() => ({ ok: true }));
  }

  @Post(':id/primary') primary(@Req() req: any, @Param('id') id: string) {
    return this.wallets.setPrimary(req.user.userId, id);
  }

  @Post(':id/withdraw') withdraw(@Req() req: any, @Param('id') id: string, @Body() dto: WithdrawDto) {
    return this.wallets.withdraw(req.user.userId, id, dto.toAddress, dto.tokenMint, dto.amount);
  }

  @Get('balances') balances(@Req() req: any) {
    return this.wallets.getAllBalances(req.user.userId);
  }

  @Get(':id/balance') balance(@Req() req: any, @Param('id') id: string) {
    return this.wallets.getBalance(req.user.userId, id);
  }

  @Get(':id/deposit') deposit(@Req() req: any, @Param('id') id: string) {
    return this.wallets.depositInfo(req.user.userId, id);
  }

  /** GET /api/wallets/:id/holdings — SPL token holdings with Birdeye prices + snipe P&L */
  @Get(':id/holdings') holdings(@Req() req: any, @Param('id') id: string) {
    return this.wallets.getHoldings(req.user.userId, id);
  }

  @Post(':id/faucet') faucet(@Req() req: any, @Param('id') id: string) {
    return this.wallets.faucet(req.user.userId, id);
  }
}
