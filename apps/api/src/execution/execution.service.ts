import { ForbiddenException, Injectable } from '@nestjs/common';
import { Chain, Prisma, TradeMode } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { GuardrailsService } from '../guardrails/guardrails.service';
import { JupiterClient } from './jupiter.client';
import { OneInchClient } from './oneinch.client';
import { WalletsService } from '../wallets/wallets.service';
import { TradingDnaService } from '../ai-agent/trading-dna.service';

export interface SwapInput {
  userId: string;
  walletId: string;
  chain: Chain;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;     // base units
  notionalUsd: number;
  slippageBps: number;
  riskFlags?: string[];
}

@Injectable()
export class ExecutionService {
  constructor(
    private prisma: PrismaService,
    private guardrails: GuardrailsService,
    private jup: JupiterClient,
    private oneinch: OneInchClient,
    private wallets: WalletsService,
    private dna: TradingDnaService,
  ) {}

  async swap(input: SwapInput) {
    const decision = await this.guardrails.check({
      userId: input.userId,
      tokenAddress: input.tokenOut,
      chain: input.chain === 'SOLANA' ? 'SOLANA' : 'EVM',
      notionalUsd: input.notionalUsd,
      slippageBps: input.slippageBps,
      riskFlags: input.riskFlags,
    });
    if (!decision.ok) throw new ForbiddenException({ guardrail: decision.reason });

    const user = await this.prisma.user.findUnique({ where: { id: input.userId } });
    const mode: TradeMode = user?.paperMode ? 'PAPER' : 'LIVE';

    let txHash: string | null = null;
    let outAmount = input.amountIn;

    if (mode === 'LIVE') {
      if (input.chain === 'SOLANA') {
        const wallet = await this.prisma.wallet.findFirst({ where: { id: input.walletId, userId: input.userId } });
        if (!wallet) throw new ForbiddenException();
        const quote = await this.jup.quote(input.tokenIn, input.tokenOut, input.amountIn, input.slippageBps);
        outAmount = quote.outAmount;
        const swap = await this.jup.swapTx(quote, wallet.address, true);
        // NOTE: tx signing + Jito bundle submission is wired in the live deploy.
        // Here we record the swap intent — actual broadcasting hooks into wallets.withSigningKey.
        txHash = swap?.txid ?? null;
      } else {
        const chainId = 1; // resolve from input.chain mapping
        const wallet = await this.prisma.wallet.findFirst({ where: { id: input.walletId, userId: input.userId } });
        if (!wallet) throw new ForbiddenException();
        const swap = await this.oneinch.swap(chainId, input.tokenIn, input.tokenOut, input.amountIn, wallet.address, input.slippageBps / 100);
        outAmount = swap?.dstAmount ?? input.amountIn;
        txHash = null;
      }
    }

    const trade = await this.prisma.trade.create({
      data: {
        userId: input.userId,
        chain: input.chain,
        side: 'buy',
        tokenIn: input.tokenIn,
        tokenOut: input.tokenOut,
        amountIn: input.amountIn,
        amountOut: outAmount,
        priceUsd: input.notionalUsd,
        mode,
        txHash: txHash ?? undefined,
      },
    });
    await this.dna.recordTrade(input.userId, { pnlUsd: 0, holdMinutes: 0 });
    await this.prisma.auditLog.create({
      data: { userId: input.userId, action: 'execution.swap', target: input.tokenOut, payload: { mode, decision } as unknown as Prisma.InputJsonValue },
    });
    return trade;
  }
}
