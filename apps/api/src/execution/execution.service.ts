import { BadRequestException, ForbiddenException, forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
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
import { LiveTradeGuardService } from '../common/live-trade-guard.service';
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
    private liveGuard: LiveTradeGuardService,
  ) {}

  async swap(input: SwapInput): Promise<SwapResult> {
    const trace: string | undefined = input.traceId ?? currentTraceId();
    // Normalize amountIn: QuickBuy sends empty string; derive from notionalUsd (SOLANA only).
    // EVM callers must supply an explicit amountIn because token decimals vary per chain.
    if (!input.amountIn && input.notionalUsd > 0) {
      if (input.chain === 'SOLANA') {
        const solUsd = await this.jup.getSolPriceUsd();
        input.amountIn = Math.round((input.notionalUsd / solUsd) * 1e9).toString();
      } else {
        throw new BadRequestException({ message: 'amountIn is required for EVM trades', traceId: trace });
      }
    }
    if (!input.amountIn) throw new BadRequestException({ message: 'amountIn must not be empty', traceId: trace });
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
    if (!user) throw new ForbiddenException({ message: 'User not found', traceId: trace });
    const mode: TradeMode = user.paperMode ? 'PAPER' : 'LIVE';

    // LiveTradeGuard — per-user rate limit + first-live-trade cap.
    if (mode === 'LIVE') {
      await this.liveGuard.checkLiveSwap({ userId: input.userId, notionalUsd: input.notionalUsd });
    }

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
        // NOTE: updatePaperBalance is called AFTER trade.create so that if the
        // trade record fails, the balance is never mutated (atomic ordering guarantee).
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

    if (mode === 'LIVE') this.liveGuard.invalidate(input.userId);
    const inferredSide = inferSwapSide(input.tokenIn, input.tokenOut);
    const trade = await this.prisma.trade.create({
      data: {
        userId: input.userId,
        orderId: input.orderId,
        chain: input.chain,
        side: inferredSide,
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

    // Paper balance is updated here, after the trade record is committed, so that
    // a trade.create failure never leaves the balance in an inconsistent state.
    if (mode === 'PAPER') {
      await this.updatePaperBalance(input.userId, input.tokenOut, outAmount);
    }

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

    // Mainnet: real Jupiter swap — retry with fresh re-quotes on slippage failure.
    // Slippage escalation: base → 2× → 4× (capped at 10 000 bps).
    const MAX_SWAP_ATTEMPTS = 3;
    const SWAP_SLIPPAGE_CEILING = 10_000;

    let lastErr: Error | null = null;
    let lastOutAmount = quote.outAmount;

    for (let attempt = 0; attempt < MAX_SWAP_ATTEMPTS; attempt++) {
      // On retries, re-quote with escalated slippage so the embedded price anchor is fresh.
      const attemptSlippage = attempt === 0
        ? input.slippageBps
        : Math.min(SWAP_SLIPPAGE_CEILING, input.slippageBps * Math.pow(2, attempt));

      const attemptQuote = attempt === 0
        ? quote
        : await this.jup.quote(input.tokenIn, input.tokenOut, input.amountIn, attemptSlippage);
      const attemptSwap = attempt === 0
        ? swap
        : await this.jup.swapTx(attemptQuote, wallet.address, true);

      if (!attemptSwap?.swapTransaction) break; // testnet mock path — shouldn't reach here on mainnet

      lastOutAmount = attemptQuote.outAmount;

      try {
        const txHash = await this.wallets.withSigningKey(input.userId, input.walletId, async (key) => {
          const kp = Keypair.fromSecretKey(new Uint8Array(key));
          const raw = Buffer.from(attemptSwap.swapTransaction, 'base64');
          const tx = VersionedTransaction.deserialize(raw);
          tx.sign([kp]);

          const { lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
          const blockhash = tx.message.recentBlockhash;

          const sig = await connection.sendRawTransaction(tx.serialize(), {
            skipPreflight: false,
            maxRetries: 3,
          });
          const result = await connection.confirmTransaction(
            { signature: sig, blockhash, lastValidBlockHeight },
            'confirmed',
          );

          if (result.value.err) {
            const errStr = JSON.stringify(result.value.err);
            const isSlippage = errStr.includes('"Custom":1') || errStr.includes('"custom":1');
            throw new Error(
              isSlippage
                ? `SLIPPAGE:Slippage exceeded (attempt ${attempt + 1}/${MAX_SWAP_ATTEMPTS}, ${attemptSlippage}bps). txHash=${sig}`
                : `Transaction failed: ${errStr}. txHash=${sig}`,
            );
          }
          return sig;
        });
        return { txHash, outAmount: lastOutAmount };
      } catch (e: any) {
        lastErr = e;
        if (!e.message?.startsWith('SLIPPAGE:')) throw e; // non-slippage error — don't retry
        this.logger.warn(`[trc=${trace}] swap slippage attempt ${attempt + 1}/${MAX_SWAP_ATTEMPTS} failed at ${attemptSlippage}bps — retrying with fresh quote`);
      }
    }

    // All attempts exhausted
    throw new Error(
      lastErr?.message?.replace('SLIPPAGE:', '') ??
      `Slippage exceeded on all ${MAX_SWAP_ATTEMPTS} attempts`,
    );
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
    // Guard: BigInt throws SyntaxError on 'NaN', 'Infinity', floats, or empty strings.
    const parsed = parseFloat(deltaAmount);
    if (!Number.isFinite(parsed) || parsed < 0) {
      this.logger.warn(`updatePaperBalance: invalid deltaAmount="${deltaAmount}" for token=${token} — skipping`);
      return;
    }
    const delta = BigInt(Math.round(parsed)).toString();
    // Atomic upsert: use create + increment-on-conflict pattern via two statements
    // wrapped in a transaction to prevent concurrent-update races.
    await this.prisma.$transaction([
      this.prisma.paperBalance.upsert({
        where:  { userId_token: { userId, token } },
        create: { userId, token, amount: delta },
        update: {},
      }),
      this.prisma.$executeRaw`
        UPDATE "PaperBalance"
        SET amount = (amount::bigint + ${BigInt(delta)}::bigint)::text
        WHERE "userId" = ${userId} AND token = ${token}
      `,
    ]);
  }
}

/**
 * Quote tokens — when the swap *outputs* one of these we treat it as a sell.
 * SOL/USDC/USDT (Solana) and WETH/USDC/USDT (EVM).
 */
const QUOTE_TOKENS = new Set<string>([
  // Solana
  'So11111111111111111111111111111111111111112',                // wSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',                // USDC (Solana)
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',                // USDT (Solana)
  // EVM (lower-cased for case-insensitive compare)
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',                  // WETH (Ethereum)
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',                  // USDC (Ethereum)
  '0xdac17f958d2ee523a2206206994597c13d831ec7',                  // USDT (Ethereum)
]);

function inferSwapSide(tokenIn: string, tokenOut: string): 'buy' | 'sell' {
  const inLc = tokenIn?.toLowerCase?.() ?? tokenIn;
  const outLc = tokenOut?.toLowerCase?.() ?? tokenOut;
  const outIsQuote = QUOTE_TOKENS.has(tokenOut) || QUOTE_TOKENS.has(outLc);
  const inIsQuote = QUOTE_TOKENS.has(tokenIn) || QUOTE_TOKENS.has(inLc);
  if (outIsQuote && !inIsQuote) return 'sell';
  return 'buy';
}
