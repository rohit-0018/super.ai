import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ExecutionService } from './execution.service';
import { OrderManagerService } from './order-manager.service';
import { PrismaService } from '../prisma/prisma.service';
import { IsEnum, IsInt, IsNumber, IsObject, IsString } from 'class-validator';
import { Chain, OrderType } from '@prisma/client';
import { detectChain } from '../token-analysis/chain-detector';
import { TokenResolverService } from '../token-resolver/token-resolver.service';
import type { ResolvedToken } from '../token-resolver/token-resolver.types';

class SwapDto {
  @IsString() walletId!: string;
  @IsEnum(Chain) chain!: Chain;
  @IsString() tokenIn!: string;
  @IsString() tokenOut!: string;
  @IsString() amountIn!: string;
  @IsNumber() notionalUsd!: number;
  @IsInt() slippageBps!: number;
}

class OrderDto {
  @IsString() walletId!: string;
  @IsEnum(OrderType) type!: OrderType;
  @IsEnum(Chain) chain!: Chain;
  @IsString() tokenIn!: string;
  @IsString() tokenOut!: string;
  @IsString() amountIn!: string;
  @IsObject() params!: Record<string, unknown>;
}

@UseGuards(JwtAuthGuard)
@Controller()
export class ExecutionController {
  constructor(
    private exec: ExecutionService,
    private orders: OrderManagerService,
    private prisma: PrismaService,
    private resolver: TokenResolverService,
  ) {}

  /**
   * Turn a tokenIn/tokenOut that may be a $TICKER into a canonical address.
   * Addresses pass through untouched (backward compatible). Tickers go through
   * the trade safety guard — ambiguous/low-liq throws 409 with candidates so
   * the client can disambiguate instead of trading the wrong token.
   */
  private async resolveLeg(
    value: string,
    chain: Chain,
  ): Promise<{ address: string; resolved?: ResolvedToken }> {
    if (detectChain(value)) return { address: value };
    const token = await this.resolver.resolveForTrade(value, {
      chain: chain === 'SOLANA' ? 'SOLANA' : 'EVM',
    });
    return { address: token.address, resolved: token };
  }

  @Post('swap')
  async swap(@Req() req: any, @Body() dto: SwapDto) {
    const [inLeg, outLeg] = await Promise.all([
      this.resolveLeg(dto.tokenIn, dto.chain),
      this.resolveLeg(dto.tokenOut, dto.chain),
    ]);
    const result = await this.exec.swap({
      userId: req.user.userId,
      ...dto,
      tokenIn: inLeg.address,
      tokenOut: outLeg.address,
    });
    return {
      ...result,
      resolvedTokenIn: inLeg.resolved ?? null,
      resolvedTokenOut: outLeg.resolved ?? null,
    };
  }

  @Get('orders') list(@Req() req: any) { return this.orders.list(req.user.userId); }

  /**
   * GET /api/trades/feed — unified trade history across all sources.
   *
   * Merges:
   *  - Trade rows (manual swaps + agent-driven trades — distinguished by
   *    strategyId presence; agent trades carry a strategyId).
   *  - SnipeTrade rows (Telegram/group sniper buys + their auto-sells).
   *
   * Sorted desc by timestamp. Use ?limit=N (default 100, max 500) to bound.
   */
  @Get('trades/feed')
  async tradesFeed(@Req() req: any, @Query('limit') limit?: string) {
    const userId: string = req.user.userId;
    const take = Math.min(Math.max(Number(limit ?? 100), 1), 500);

    const [trades, snipes] = await Promise.all([
      this.prisma.trade.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take,
        select: {
          id: true, side: true, chain: true, tokenIn: true, tokenOut: true,
          amountIn: true, amountOut: true, priceUsd: true, pnlUsd: true,
          mode: true, txHash: true, strategyId: true, createdAt: true,
        },
      }),
      this.prisma.snipeTrade.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take,
      }),
    ]);

    type FeedItem = {
      id: string;
      kind: 'manual' | 'agent' | 'snipe' | 'snipe_sell';
      side: 'buy' | 'sell';
      chain: string;
      mint: string | null;
      tokenIn: string | null;
      tokenOut: string | null;
      amountIn: string | null;
      amountOut: string | null;
      priceUsd: number | null;
      pnlUsd: number | null;
      mode: string;
      txHash: string | null;
      status: string;
      strategyId: string | null;
      sourceMsg: string | null;
      createdAt: string;
    };

    const items: FeedItem[] = [];

    for (const t of trades) {
      items.push({
        id: t.id,
        kind: t.strategyId ? 'agent' : 'manual',
        side: (t.side === 'sell' ? 'sell' : 'buy'),
        chain: t.chain,
        mint: t.side === 'sell' ? t.tokenIn : t.tokenOut,
        tokenIn: t.tokenIn,
        tokenOut: t.tokenOut,
        amountIn: t.amountIn,
        amountOut: t.amountOut ?? null,
        priceUsd: t.priceUsd ?? null,
        pnlUsd: t.pnlUsd ?? null,
        mode: t.mode,
        txHash: t.txHash ?? null,
        status: 'confirmed',
        strategyId: t.strategyId ?? null,
        sourceMsg: null,
        createdAt: t.createdAt.toISOString(),
      });
    }

    for (const s of snipes) {
      items.push({
        id: s.id,
        kind: 'snipe',
        side: 'buy',
        chain: s.chain,
        mint: s.mint,
        tokenIn: 'SOL',
        tokenOut: s.mint,
        amountIn: s.amountRaw,
        amountOut: s.outAmount ?? null,
        priceUsd: (s as any).priceAtBuyUsd ?? null,
        pnlUsd: null,
        mode: 'LIVE',
        txHash: s.txHash ?? null,
        status: s.status,
        strategyId: null,
        sourceMsg: s.sourceMsg ?? null,
        createdAt: s.createdAt.toISOString(),
      });

      if (s.sellStatus && s.sellStatus !== 'pending') {
        items.push({
          id: `${s.id}:sell`,
          kind: 'snipe_sell',
          side: 'sell',
          chain: s.chain,
          mint: s.mint,
          tokenIn: s.mint,
          tokenOut: 'SOL',
          amountIn: s.outAmount ?? null,
          amountOut: (s as any).proceedsSolAtSell != null
            ? String(Math.round(((s as any).proceedsSolAtSell as number) * 1_000_000_000))
            : null,
          priceUsd: null,
          pnlUsd: (s as any).pnlUsdRealized ?? null,
          mode: 'LIVE',
          txHash: s.sellTxHash ?? null,
          status: s.sellStatus,
          strategyId: null,
          sourceMsg: s.sellReason ?? null,
          createdAt: s.createdAt.toISOString(),
        });
      }
    }

    items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return items.slice(0, take);
  }

  @Post('orders')
  async place(@Req() req: any, @Body() dto: OrderDto) {
    const [inLeg, outLeg] = await Promise.all([
      this.resolveLeg(dto.tokenIn, dto.chain),
      this.resolveLeg(dto.tokenOut, dto.chain),
    ]);
    const result = await this.orders.place({
      userId: req.user.userId,
      ...dto,
      tokenIn: inLeg.address,
      tokenOut: outLeg.address,
    });
    return {
      ...result,
      resolvedTokenIn: inLeg.resolved ?? null,
      resolvedTokenOut: outLeg.resolved ?? null,
    };
  }

  @Delete('orders/:id')
  cancel(@Req() req: any, @Param('id') id: string) {
    return this.orders.cancel(req.user.userId, id);
  }
}
