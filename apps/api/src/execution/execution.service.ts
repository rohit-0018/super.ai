import { ForbiddenException, forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { Chain, OrderStatus, Prisma, TradeMode } from '@prisma/client';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { ethers } from 'ethers';
import { getSolanaRpcUrl, getEvmRpcUrl, getEvmChainId, isTestnet, getNetworkMode } from '../common/network-config';
import { currentTraceId } from '../common/trace-context';
import { PrismaService } from '../prisma/prisma.service';
import { GuardrailsService } from '../guardrails/guardrails.service';
import { JupiterClient } from './jupiter.client';
import { OneInchClient } from './oneinch.client';
import { WalletsService } from '../wallets/wallets.service';
import { TradingDnaService } from '../ai-agent/trading-dna.service';
import { EmotionalIntelService } from '../agents/emotional-intel.service';
import { SecurityComplianceService } from '../security/security-compliance.service';
import { RiskEngineService } from '../security/risk-engine.service';
import { SecurityAuditService } from '../security/security-audit.service';
import { makeQueue, makeJobData, QUEUES } from '../agents/queues';
import {
  AgentActionType,
  OrderSide,
  OrderType,
  type PlaceOrderAction,
} from '@super-ai/security';

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
  /** Attributed strategy (autonomous-trader path); null for manual/chat trades. */
  strategyId?: string;
  /** L5 conviction breakdown snapshot; autonomous-trader path only. */
  convictionBreakdown?: Record<string, unknown>;
  /** Optional — if absent, falls back to ambient AsyncLocalStorage traceId. */
  traceId?: string;
}

export interface SwapResult {
  tradeId: string;
  txHash: string | null;
  amountOut: string;
  mode: TradeMode;
  traceId?: string;
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
    @Inject(forwardRef(() => EmotionalIntelService))
    private emotional: EmotionalIntelService,
    private securityCompliance: SecurityComplianceService,
    private riskEngine: RiskEngineService,
    private securityAudit: SecurityAuditService,
  ) {}

  async swap(input: SwapInput): Promise<SwapResult> {
    const trace: string | undefined = input.traceId ?? currentTraceId();
    // ── Security layer: audit, compliance, and risk checks ──
    await this.securityAudit.log('SWAP_INITIATED', {
      userId: input.userId,
      walletId: input.walletId,
      chain: input.chain,
      tokenIn: input.tokenIn,
      tokenOut: input.tokenOut,
      amountIn: input.amountIn,
      notionalUsd: input.notionalUsd,
      traceId: trace,
    }, { userId: input.userId });

    const orderAction: PlaceOrderAction = {
      type: AgentActionType.PlaceOrder,
      instrument: `${input.tokenIn}-${input.tokenOut}`,
      side: OrderSide.BUY,
      orderType: OrderType.MARKET,
      quantity: parseFloat(input.amountIn) || 0,
      strategyId: 'swap',
      clientOrderId: input.orderId ?? crypto.randomUUID(),
    };

    // Wash trade check
    const washResult = await this.securityCompliance.checkWashTrade(orderAction, input.userId);
    if (washResult.detected) {
      await this.securityAudit.log('COMPLIANCE_WASH_TRADE_BLOCKED', {
        userId: input.userId,
        instrument: orderAction.instrument,
        relatedOrderId: washResult.relatedOrderId,
        traceId: trace,
      }, { userId: input.userId });
      this.logger.warn(`[trc=${trace}] wash trade blocked user=${input.userId} instrument=${orderAction.instrument}`);
      throw new ForbiddenException({
        message: 'Wash trade detected — swap blocked by compliance',
        traceId: trace,
      });
    }

    // Risk engine evaluation
    const riskResult = await this.riskEngine.evaluate(orderAction, {
      userId: input.userId,
      strategyId: 'swap',
      portfolio: { positions: [], totalNotional: input.notionalUsd, totalUnrealizedPnl: 0, drawdownFromHighWatermarkPercent: 0 },
      sessionId: input.userId,
    });
    if (!riskResult.approved) {
      await this.securityAudit.log('RISK_ENGINE_BLOCKED', {
        userId: input.userId,
        instrument: orderAction.instrument,
        blockReasons: riskResult.blockReasons,
        riskLevel: riskResult.riskLevel,
        traceId: trace,
      }, { userId: input.userId });
      this.logger.warn(`[trc=${trace}] risk blocked user=${input.userId} reasons=${(riskResult.blockReasons ?? []).join(',')}`);
      throw new ForbiddenException({
        message: 'Swap blocked by risk engine',
        reasons: riskResult.blockReasons,
        traceId: trace,
      });
    }

    // ── Existing guardrails ──
    const decision = await this.guardrails.check({
      userId: input.userId,
      tokenAddress: input.tokenOut,
      chain: input.chain === 'SOLANA' ? 'SOLANA' : 'EVM',
      notionalUsd: input.notionalUsd,
      slippageBps: input.slippageBps,
      riskFlags: input.riskFlags,
    });
    if (!decision.ok) throw new ForbiddenException({ guardrail: decision.reason, traceId: trace });

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
        // PAPER mode: try to fetch a real quote for realistic outAmount.
        // If DEX fetch fails (no network, bad token address), simulate it.
        try {
          if (input.chain === 'SOLANA') {
            const quote = await this.jup.quote(input.tokenIn, input.tokenOut, input.amountIn, input.slippageBps);
            outAmount = quote.outAmount;
          } else {
            const chainId = this.resolveEvmChainId(input);
            const quote = await this.oneinch.quote(chainId, input.tokenIn, input.tokenOut, input.amountIn);
            outAmount = quote?.dstAmount ?? input.amountIn;
          }
        } catch (quoteErr: any) {
          this.logger.warn(`[trc=${trace}] Paper mode quote failed (using simulated amount): ${quoteErr.message}`);
          outAmount = input.amountIn; // 1:1 simulated ratio
        }
        txHash = `paper-${Date.now().toString(36)}`;
        await this.updatePaperBalance(input.userId, input.tokenOut, outAmount);
      }
    } catch (err: any) {
      this.logger.error(`[trc=${trace}] swap failed user=${input.userId} chain=${input.chain}: ${err.message}`);
      await this.prisma.auditLog.create({
        data: {
          userId: input.userId,
          action: 'execution.swap.failed',
          target: input.tokenOut,
          payload: { reason: err.message, mode, traceId: trace } as unknown as Prisma.InputJsonValue,
        },
      });
      if (input.orderId) {
        await this.prisma.order.update({
          where: { id: input.orderId },
          data: { status: OrderStatus.FAILED, ...(trace ? { traceId: trace } : {}) } as unknown as Prisma.OrderUpdateInput,
        });
      }
      await this.securityAudit.log('SWAP_FAILED', {
        userId: input.userId,
        chain: input.chain,
        tokenIn: input.tokenIn,
        tokenOut: input.tokenOut,
        reason: err.message,
        traceId: trace,
      }, { userId: input.userId });
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
        ...(input.strategyId ? { strategyId: input.strategyId } : {}),
        ...(input.convictionBreakdown ? {
          convictionBreakdown: input.convictionBreakdown as any,
          convictionVersion: (input.convictionBreakdown as any).weightsVersion ?? null,
        } : {}),
        ...(trace ? { traceId: trace } : {}),
      } as unknown as Prisma.TradeCreateInput,
    });

    if (input.orderId) {
      await this.prisma.order.update({
        where: { id: input.orderId },
        data: {
          status: OrderStatus.FILLED,
          txHash: txHash ?? undefined,
          ...(trace ? { traceId: trace } : {}),
        } as unknown as Prisma.OrderUpdateInput,
      });
    }

    // Security: record order for compliance tracking
    await this.securityCompliance.recordOrder(orderAction, input.userId);
    await this.securityAudit.log('SWAP_COMPLETED', {
      userId: input.userId,
      tradeId: trade.id,
      txHash,
      mode,
      tokenIn: input.tokenIn,
      tokenOut: input.tokenOut,
      amountIn: input.amountIn,
      amountOut: outAmount,
      traceId: trace,
    }, { userId: input.userId });

    this.logger.log(`[trc=${trace}] swap completed user=${input.userId} trade=${trade.id} mode=${mode} txHash=${txHash ?? 'none'}`);

    await this.dna.recordTrade(input.userId, { pnlUsd: 0, holdMinutes: 0 });
    this.emotional.evaluate(input.userId).catch((e) => this.logger.warn(`[trc=${trace}] Emotional eval failed: ${e.message}`));

    // Fan out learning observation. Gated by LearningConfig.enabled inside the
    // worker so it is always safe to enqueue; failures here must never affect
    // the trade result path.
    try {
      const queue = makeQueue(QUEUES.LEARNING_INGEST);
      await queue.add(
        'ingest',
        makeJobData({ userId: input.userId, tradeId: trade.id }),
        { removeOnComplete: 500, removeOnFail: 100 },
      );
    } catch (e: any) {
      this.logger.warn(`[trc=${trace}] learning enqueue failed: ${e.message}`);
    }

    // L2 episodic memory fan-out. Also gated inside the worker on
    // EPISODIC_MEMORY_ENABLED + LearningConfig.enabled.
    if (process.env.EPISODIC_MEMORY_ENABLED === 'true') {
      try {
        const q = makeQueue(QUEUES.EPISODE_INGEST);
        await q.add(
          'ingest',
          makeJobData({
            userId: input.userId,
            tradeId: trade.id,
            kind: mode === 'PAPER' ? 'PAPER' : 'EXECUTED',
            chain: input.chain,
            token: input.tokenOut,
            side: 'buy',
            decisionSeed: {
              notionalUsd: input.notionalUsd,
              slippageBps: input.slippageBps,
              amountIn: input.amountIn,
              riskFlags: input.riskFlags ?? [],
            },
          }),
          { removeOnComplete: 500, removeOnFail: 100 },
        );
      } catch (e: any) {
        this.logger.warn(`[trc=${trace}] episode enqueue failed: ${e.message}`);
      }
    }
    await this.prisma.auditLog.create({
      data: {
        userId: input.userId,
        action: 'execution.swap',
        target: input.tokenOut,
        payload: { mode, txHash, decision, traceId: trace } as unknown as Prisma.InputJsonValue,
      },
    });

    return { tradeId: trade.id, txHash, amountOut: outAmount, mode, traceId: trace };
  }

  async multiWalletBuy(userId: string, walletIds: string[], input: Omit<SwapInput, 'userId' | 'walletId'>): Promise<SwapResult[]> {
    const trace = input.traceId ?? currentTraceId();
    const results: SwapResult[] = [];
    for (const walletId of walletIds) {
      try {
        const result = await this.swap({ ...input, userId, walletId, traceId: trace });
        results.push(result);
      } catch (e: any) {
        this.logger.warn(`[trc=${trace}] Multi-wallet buy wallet=${walletId} failed: ${e.message}`);
        results.push({ tradeId: '', txHash: null, amountOut: '0', mode: 'PAPER' as TradeMode, traceId: trace });
      }
    }
    return results;
  }

  private async executeSolana(input: SwapInput): Promise<{ txHash: string; outAmount: string }> {
    const trace: string | undefined = input.traceId ?? currentTraceId();
    const wallet = await this.prisma.wallet.findFirst({
      where: { id: input.walletId, userId: input.userId },
    });
    if (!wallet) throw new ForbiddenException({ message: 'wallet not found', traceId: trace });

    const quote = await this.jup.quote(input.tokenIn, input.tokenOut, input.amountIn, input.slippageBps);
    const swap = await this.jup.swapTx(quote, wallet.address, true);

    const rpcUrl = getSolanaRpcUrl();
    const connection = new Connection(rpcUrl, 'confirmed');

    // Testnet: Jupiter mock returns no swapTransaction. Do a direct SOL
    // transfer to self as a recorded on-chain tx instead.
    if (swap?.testnetMock || !swap?.swapTransaction) {
      this.logger.log(`[trc=${trace}] [testnet] Executing devnet SOL self-transfer for trade record`);
      const { SystemProgram, Transaction, sendAndConfirmTransaction, PublicKey } = await import('@solana/web3.js');
      const txHash = await this.wallets.withSigningKey(input.userId, input.walletId, async (key) => {
        const kp = Keypair.fromSecretKey(new Uint8Array(key));
        const lamports = Math.max(1000, Math.round(parseFloat(input.amountIn) * 1e6));
        const tx = new Transaction().add(
          SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: kp.publicKey, lamports }),
        );
        return sendAndConfirmTransaction(connection, tx, [kp]);
      });
      return { txHash, outAmount: quote.outAmount };
    }

    // Mainnet: real Jupiter swap
    const swapTxB64: string = swap.swapTransaction;
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
    const trace: string | undefined = input.traceId ?? currentTraceId();
    const wallet = await this.prisma.wallet.findFirst({
      where: { id: input.walletId, userId: input.userId },
    });
    if (!wallet) throw new ForbiddenException({ message: 'wallet not found', traceId: trace });

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

    // Testnet: 1inch mock returns no real calldata. Do a self-transfer.
    if (swap?.testnetMock || !swap?.tx?.data) {
      this.logger.log(`[trc=${trace}] [testnet] Executing Sepolia self-transfer for trade record`);
      const txHash = await this.wallets.withSigningKey(input.userId, input.walletId, async (key) => {
        const signer = new ethers.Wallet('0x' + key.toString('hex'), provider);
        const sent = await signer.sendTransaction({
          to: wallet.address,
          value: 1000n, // minimal wei
        });
        await sent.wait(1);
        return sent.hash;
      });
      return { txHash, outAmount: swap?.dstAmount ?? input.amountIn };
    }

    // Mainnet: real 1inch swap
    const txReq = swap.tx;
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
        return getEvmRpcUrl();
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
