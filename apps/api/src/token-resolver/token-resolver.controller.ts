import { Controller, Get, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { TokenResolverService } from './token-resolver.service';
import type { Chain, ResolveResult } from './token-resolver.types';

class ResolveQueryDto {
  /** Raw user input: a contract address, or a ticker (with or without `$`). */
  @IsString() q!: string;

  @IsOptional() @IsIn(['SOLANA', 'EVM']) chain?: Chain;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(25) limit?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) minLiquidityUsd?: number;
}

@Controller('resolve')
export class TokenResolverController {
  constructor(private readonly resolver: TokenResolverService) {}

  /**
   * GET /api/resolve?q=$BONK&chain=SOLANA&limit=8
   * Read-only public market lookup (same access posture as /api/market/*).
   */
  @Get()
  resolve(@Query() dto: ResolveQueryDto): Promise<ResolveResult> {
    return this.resolver.resolve(dto.q, {
      chain: dto.chain,
      limit: dto.limit,
      minLiquidityUsd: dto.minLiquidityUsd,
    });
  }
}
