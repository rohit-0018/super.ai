import { Injectable } from '@nestjs/common';
import { AgentKind, AgentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type DcaInterval = 'hourly' | 'daily' | 'weekly' | 'monthly';

@Injectable()
export class DcaService {
  constructor(private prisma: PrismaService) {}

  create(userId: string, params: {
    walletId: string; tokenIn: string; tokenOut: string;
    amountUsd: number; interval: DcaInterval; chain: 'SOLANA' | 'EVM';
  }) {
    return this.prisma.agent.create({
      data: { userId, kind: AgentKind.DCA, status: AgentStatus.RUNNING, params: params as any },
    });
  }

  list(userId: string) {
    return this.prisma.agent.findMany({ where: { userId, kind: AgentKind.DCA } });
  }
}
