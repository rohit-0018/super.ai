import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { WalletsService } from './wallets.service';
import { BulkWalletService } from './bulk-wallet.service';
import { ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
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

class RenameLabelDto {
  @IsString() label!: string;
}

class WithdrawDto {
  @IsString() toAddress!: string;
  @IsString() tokenMint!: string;
  @IsNumber() @Min(0) amount!: number;
}


/**
 * Bulk operations. `confirm` is deliberately required on the execute paths —
 * the service refuses to move funds without it, so a mis-wired client gets a
 * 400 rather than an irreversible transfer.
 */
class BulkCreateDto {
  @IsEnum(Chain) chain!: Chain;
  @IsInt() @Min(1) @Max(50) count!: number;
  @IsOptional() @IsString() labelPrefix?: string;
}

class DistributeDto {
  @IsString() fromWalletId!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) toWalletIds?: string[];
  @IsNumber() @Min(0) amountPerWallet!: number;
  @IsOptional() @IsString() chainKey?: string;
  @IsOptional() @IsBoolean() confirm?: boolean;
}

class CollectDto {
  @IsString() toWalletId!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) fromWalletIds?: string[];
  @IsOptional() @IsString() chainKey?: string;
  @IsOptional() @IsNumber() @Min(0) leaveBehind?: number;
  @IsOptional() @IsBoolean() confirm?: boolean;
}

@UseGuards(JwtAuthGuard)
@Controller('wallets')
export class WalletsController {
  constructor(
    private wallets: WalletsService,
    private bulk: BulkWalletService,
  ) {}

  @Get() list(@Req() req: any) { return this.wallets.list(req.user.userId); }

  @Post() create(@Req() req: any, @Body() dto: CreateWalletDto) {
    return this.wallets.create(req.user.userId, dto.chain, dto.label);
  }

  @Post('import') import(@Req() req: any, @Body() dto: ImportWalletDto) {
    return this.wallets.importWallet(req.user.userId, dto.chain, dto.privateKey, dto.label);
  }

  @Post('export-all') exportAll(@Req() req: any) {
    return this.wallets.exportAll(req.user.userId);
  }

  @Post(':id/export') export(@Req() req: any, @Param('id') id: string) {
    return this.wallets.exportKey(req.user.userId, id).then((key) => ({ key }));
  }

  @Post(':id/confirm-backup') confirmBackup(@Req() req: any, @Param('id') id: string) {
    return this.wallets.confirmBackup(req.user.userId, id).then(() => ({ ok: true }));
  }

  @Patch(':id/label') rename(@Req() req: any, @Param('id') id: string, @Body() dto: RenameLabelDto) {
    return this.wallets.renameWallet(req.user.userId, id, dto.label.trim());
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
  @Get(':id/holdings') holdings(
    @Req() req: any,
    @Param('id') id: string,
    @Query('chain') chain?: string,
  ) {
    return this.wallets.getHoldings(req.user.userId, id, chain);
  }

  @Post(':id/faucet') faucet(@Req() req: any, @Param('id') id: string) {
    return this.wallets.faucet(req.user.userId, id);
  }

  // ── Bulk operations ──

  /** Create many wallets at once. Returns each private key ONCE — prompt for backup. */
  @Post('bulk/create') bulkCreate(@Req() req: any, @Body() dto: BulkCreateDto) {
    return this.bulk.bulkCreate({ userId: req.user.userId, ...dto });
  }

  /** Preview a fan-out fund. No keys touched, nothing moves. */
  @Post('bulk/distribute/plan') planDistribute(@Req() req: any, @Body() dto: DistributeDto) {
    return this.bulk.planDistribute({ userId: req.user.userId, ...dto });
  }

  /** Execute the fan-out. Requires confirm: true. */
  @Post('bulk/distribute') distribute(@Req() req: any, @Body() dto: DistributeDto) {
    return this.bulk.executeDistribute({ userId: req.user.userId, ...dto });
  }

  /** Preview sweeping many wallets into one, including the gas reserve per wallet. */
  @Post('bulk/collect/plan') planCollect(@Req() req: any, @Body() dto: CollectDto) {
    return this.bulk.planCollect({ userId: req.user.userId, ...dto });
  }

  /** Execute the sweep. Requires confirm: true. */
  @Post('bulk/collect') collect(@Req() req: any, @Body() dto: CollectDto) {
    return this.bulk.executeCollect({ userId: req.user.userId, ...dto });
  }
}
