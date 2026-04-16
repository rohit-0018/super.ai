import { Injectable } from '@nestjs/common';
import { Chain, OrderStatus, OrderType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface PlaceOrderInput {
  userId: string;
  walletId: string;
  type: OrderType;
  chain: Chain;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  params: Record<string, unknown>; // limitPrice, stopPrice, trailBps, takeProfit, dcaInterval, etc.
  /** WEB | CHAT | TELEGRAM | AGENT | DCA | SCHEDULED | API */
  source?: string;
}

@Injectable()
export class OrderManagerService {
  constructor(private prisma: PrismaService) {}

  place(input: PlaceOrderInput) {
    return this.prisma.order.create({
      data: {
        ...input,
        params: input.params as any,
        status: OrderStatus.PENDING,
        source: input.source ?? 'API',
      },
    });
  }

  list(userId: string) {
    return this.prisma.order.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
  }

  cancel(userId: string, orderId: string) {
    return this.prisma.order.updateMany({ where: { id: orderId, userId }, data: { status: OrderStatus.CANCELLED } });
  }

  markFilled(orderId: string, txHash: string) {
    return this.prisma.order.update({ where: { id: orderId }, data: { status: OrderStatus.FILLED, txHash } });
  }
}
