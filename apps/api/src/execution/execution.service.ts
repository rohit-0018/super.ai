import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Chain, OrderStatus, Prisma, TradeMode } from '@prisma/client';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { ethers } from 'ethers';
import { PrismaService } from '../prisma/prisma.service';
import { GuardrailsService } from '../guardrails/guardrails.service';
import { JupiterClient } from './jupiter.client';
import { OneInchClient } from './oneinch.client';
import { WalletsService } from '../wallets/wallets.service';
import { TradingDnaService } from '../ai-agent/trading-dna.service';
import { EmotionalIntelService } from '../agents/emotional-intel.service';

export interface SwapInput {
  userId: string;
  walletId: string;
  chain: Chain;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  notionalUsd: number;
  slippageBps: number;
  riskFlags?: string[];
  orderId?: string;
}

export interface SwapResult {
  tradeId: string;
  txHash: string | null;
  amountOut: string;
  mode: TradeMode;
}

const EVM_CHAIN_IDS: Record<string, number> = {
  ETH: 1,
  ARBITRUM: 42161,
  BASE: 8453,
};

@Injectable()
export class ExecutionService {
  private readonly logger = new Logger(ExecutionService.name);

  constructor(
    private prisma: PrismaService,
    private guardrails: GuardrailsService,
    private jup: JupiterClient,
    private oneinch: OneInchClient,
    private wallets: WalletsService,
    private dna: TradingDnaService,
    private emotional: EmotionalIntelService,
  ) {}

  async swap(input: SwapInput): Promise<SwapResult> {
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

    try {
      if (mode === 'LIVE') {
        if (input.chain === 'SOLANA') {
          const res = await this.executeSolana(input);
          txHash = res.txHash;
          outAmount = res.outAmount;
        } else {
          const res = await this.executeEvm(input);
          txHash = res.txHash;
          outAmount = res.outAmount;
        }
      } else {
        // PAPER mode: still fetch a quote for realistic outAmount, but don't broadcast.
        if (input.chain === 'SOLANA') {
          const quote = await this.jup.quote(input.tokenIn, input.tokenOut, input.amountIn, input.slippageBps);
          outAmount = quote.outAmount;
        } else {
          const chainId = this.resolveEvmChainId(input);
          const quote = await this.oneinch.quote(chainId, input.tokenIn, input.tokenOut, input.amountIn);
          outAmount = quote?.dstAmount ?? input.amountIn;
        }
        await this.updatePaperBalance(input.userId, input.tokenOut, outAmount);
      }
    } catch (err: any) {
      this.logger.error(`swap failed user=${input.userId} chain=${input.chain}: ${err.message}`);
      await this.prisma.auditLog.create({
        data: {
          userId: input.userId,
          action: 'execution.swap.failed',
          target: input.tokenOut,
          payload: { reason: err.message, mode } as unknown as Prisma.InputJsonValue,
        },
      });
      if (input.orderId) {
        await this.prisma.order.update({
          where: { id: input.orderId },
          data: { status: OrderStatus.FAILED },
        });
      }
      throw err;
    }

    const trade = await this.prisma.trade.create({
      data: {
        userId: input.userId,
        orderId: input.orderId,
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

    if (input.orderId) {
      await this.prisma.order.update({
        where: { id: input.orderId },
        data: { status: OrderStatus.FILLED, txHash: txHash ?? undefined },
      });
    }

    await this.dna.recordTrade(input.userId, { pnlUsd: 0, holdMinutes: 0 });
    this.emotional.evaluate(input.userId).catch((e) => this.logger.warn(`Emotional eval failed: ${e.message}`));
    await this.prisma.auditLog.create({
      data: {
        userId: input.userId,
        action: 'execution.swap',
        target: input.tokenOut,
        payload: { mode, txHash, decision } as unknown as Prisma.InputJsonValue,
      },
    });

    return { tradeId: trade.id, txHash, amountOut: outAmount, mode };
  }

  async multiWalletBuy(userId: string, walletIds: string[], input: Omit<SwapInput, 'userId' | 'walletId'>): Promise<SwapResult[]> {
    const results: SwapResult[] = [];
    for (const walletId of walletIds) {
      try {
        const result = await this.swap({ ...input, userId, walletId });
        results.push(result);
      } catch (e: any) {
        this.logger.warn(`Multi-wallet buy wallet=${walletId} failed: ${e.message}`);
        results.push({ tradeId: '', txHash: null, amountOut: '0', mode: 'PAPER' as TradeMode });
      }
    }
    return results;
  }

  private async executeSolana(input: SwapInput): Promise<{ txHash: string; outAmount: string }> {
    const wallet = await this.prisma.wallet.findFirst({
      where: { id: input.walletId, userId: input.userId },
    });
    if (!wallet) throw new ForbiddenException();

    const quote = await this.jup.quote(input.tokenIn, input.tokenOut, input.amountIn, input.slippageBps);
    const swap = await this.jup.swapTx(quote, wallet.address, true);
    const swapTxB64: string | undefined = swap?.swapTransaction;
    if (!swapTxB64) throw new Error('Jupiter returned no swapTransaction');

    const rpcUrl = process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
    const connection = new Connection(rpcUrl, 'confirmed');

    const txHash = await this.wallets.withSigningKey(input.userId, input.walletId, async (key) => {
      const kp = Keypair.fromSecretKey(new Uint8Array(key));
      const raw = Buffer.from(swapTxB64, 'base64');
      const tx = VersionedTransaction.deserialize(raw);
      tx.sign([kp]);
      const sig = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });
      const latest = await connection.getLatestBlockhash('confirmed');
      await connection.confirmTransaction(
        { signature: sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
        'confirmed',
      );
      return sig;
    });

    return { txHash, outAmount: quote.outAmount };
  }

  private async executeEvm(input: SwapInput): Promise<{ txHash: string; outAmount: string }> {
    const wallet = await this.prisma.wallet.findFirst({
      where: { id: input.walletId, userId: input.userId },
    });
    if (!wallet) throw new ForbiddenException();

    const chainId = this.resolveEvmChainId(input);
    const rpcUrl = this.resolveEvmRpc(chainId);
    const provider = new ethers.JsonRpcProvider(rpcUrl);

    const swap = await this.oneinch.swap(
      chainId,
      input.tokenIn,
      input.tokenOut,
      input.amountIn,
      wallet.address,
      input.slippageBps / 100,
    );
    const txReq = swap?.tx;
    if (!txReq?.to || !txReq?.data) throw new Error('1inch returned no tx calldata');

    const txHash = await this.wallets.withSigningKey(input.userId, input.walletId, async (key) => {
      const signer = new ethers.Wallet('0x' + key.toString('hex'), provider);
      const sent = await signer.sendTransaction({
        to: txReq.to,
        data: txReq.data,
        value: txReq.value ? BigInt(txReq.value) : 0n,
        gasLimit: txReq.gas ? BigInt(txReq.gas) : undefined,
        gasPrice: txReq.gasPrice ? BigInt(txReq.gasPrice) : undefined,
      });
      await sent.wait(1);
      return sent.hash;
    });

    return { txHash, outAmount: swap?.dstAmount ?? input.amountIn };
  }

  private resolveEvmChainId(input: SwapInput): number {
    const hint = (input.riskFlags ?? []).find((f) => f.startsWith('chainId:'));
    if (hint) return parseInt(hint.split(':')[1], 10);
    return EVM_CHAIN_IDS.ETH;
  }

  private resolveEvmRpc(chainId: number): string {
    switch (chainId) {
      case EVM_CHAIN_IDS.ARBITRUM:
        return process.env.ARBITRUM_RPC_URL ?? 'https://arb1.arbitrum.io/rpc';
      case EVM_CHAIN_IDS.BASE:
        return process.env.BASE_RPC_URL ?? 'https://mainnet.base.org';
      default:
        return process.env.ETH_RPC_URL ?? 'https://eth.llamarpc.com';
    }
  }

  private async updatePaperBalance(userId: string, token: string, deltaAmount: string) {
    const existing = await this.prisma.paperBalance.findUnique({
      where: { userId_token: { userId, token } },
    });
    const prev = BigInt(existing?.amount ?? '0');
    const next = (prev + BigInt(deltaAmount)).toString();
    await this.prisma.paperBalance.upsert({
      where: { userId_token: { userId, token } },
      update: { amount: next },
      create: { userId, token, amount: next },
    });
  }
}
