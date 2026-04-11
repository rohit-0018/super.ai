import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ExecutionService } from './execution.service';
import { OrderManagerService } from './order-manager.service';
import { IsEnum, IsInt, IsNumber, IsObject, IsString } from 'class-validator';
import { Chain, OrderType } from '@prisma/client';

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
  constructor(private exec: ExecutionService, private orders: OrderManagerService) {}

  @Post('swap')
  swap(@Req() req: any, @Body() dto: SwapDto) {
    return this.exec.swap({ userId: req.user.userId, ...dto });
  }

  @Get('orders') list(@Req() req: any) { return this.orders.list(req.user.userId); }

  @Post('orders')
  place(@Req() req: any, @Body() dto: OrderDto) {
    return this.orders.place({ userId: req.user.userId, ...dto });
  }

  @Delete('orders/:id')
  cancel(@Req() req: any, @Param('id') id: string) {
    return this.orders.cancel(req.user.userId, id);
  }
}
