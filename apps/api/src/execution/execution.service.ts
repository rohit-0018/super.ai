import { BadGatewayException, ForbiddenException, Injectable, Logger, Optional, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Chain, OrderStatus, Prisma, TradeMode } from '@prisma/client';
import { Connection, Keypair, VersionedTransaction, TransactionMessage, PublicKey } from '@solana/web3.js';
import { ethers } from 'ethers';
import {
  getSolanaRpcUrl,
  getEvmRpcUrl,
  getEvmChainId,
  isTestnet,
  getNetworkMode,
  getSolanaExplorerUrl,
  getEvmExplorerUrl,
} from '../common/network-config';

export class SwapExecutionError extends Error {
  constructor(
    message: string,
    public readonly reason: string,
    public readonly context: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SwapExecutionError';
  }
}

// Well-known quote-asset mints / addresses used to infer trade side.
const SOLANA_QUOTE_MINTS = new Set<string>([
  'So11111111111111111111111111111111111111112', // wSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);
const EVM_QUOTE_TOKENS = new Set<string>([
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', // native
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC mainnet
  '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT mainnet
]);

function inferSide(chain: Chain, tokenIn: string): 'buy' | 'sell' {
  const norm = tokenIn.toLowerCase();
  if (chain === 'SOLANA') {
    return SOLANA_QUOTE_MINTS.has(tokenIn) ? 'buy' : 'sell';
  }
  return EVM_QUOTE_TOKENS.has(norm) ? 'buy' : 'sell';
}
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
import { ParallelRpcClient } from '../fast-lane/parallel-rpc.client';
import { JitoClient } from '../fast-lane/jito.client';
import { PriorityFeeService } from '../fast-lane/priority-fee.service';
import { PriceCacheService } from '../fast-lane/price-cache.service';
import bs58 from 'bs58';
import { randomBytes } from 'crypto';
import {
  AgentActionType,
  OrderSide,
  OrderType,
  type PlaceOrderAction,
} from '@super-ai/security';
import {
  formatSwapSuccess,
  formatSwapFailure,
  type SwapStatus,
  type SwapNetwork,
  type SwapSuccessPayload,
} from './swap-message';

export type { SwapStatus } from './swap-message';

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
  fastLane?: boolean;
  /**
   * Origin tag for verification & filtering in the activity feed.
   * Conventional values: WEB | CHAT | TELEGRAM | AGENT | DCA | SCHEDULED | FAST_LANE | API
   * Defaults to 'API' if not provided.
   */
  source?: string;
}

export interface FastLaneTelemetry {
  usedUndiciPool: boolean;
  usedJito: boolean;
  usedParallelRpc: boolean;
  skippedPreflight: boolean;
  skippedQuote: boolean;
  fireAndForget: boolean;
  priorityFeeMicroLamports: number;
  jitoTipLamports: number;
  jitoBundleId?: string;
  winningRpc?: string;
  totalMs: number;
}

export interface SwapResult {
  tradeId: string;
  status: SwapStatus;
  simulated: boolean;
  network: SwapNetwork;
  mode: TradeMode;
  side: 'buy' | 'sell';
  chain: Chain;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  notionalUsd: number;
  txHash: string | null;
  explorerUrl: string | null;
  explorerLabel: string | null;
  message: string;
}

const SOL_SIM_PREFIX = 'testnet-sim-';
const PAPER_PREFIX = 'paper-';

function makeSimulatedHash(prefix: 'paper' | 'testnet'): string {
  const id = randomBytes(8).toString('hex');
  return `${prefix === 'paper' ? PAPER_PREFIX : SOL_SIM_PREFIX}${id}`;
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
    private securityCompliance: SecurityComplianceService,
    private riskEngine: RiskEngineService,
    private securityAudit: SecurityAuditService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly parallelRpc?: ParallelRpcClient,
    @Optional() private readonly jito?: JitoClient,
    @Optional() private readonly priorityFee?: PriorityFeeService,
    @Optional() private readonly priceCache?: PriceCacheService,
  ) {}

  // ─── Fast Lane config helpers ────────────────────────────────────────────

  private isSkipPreflight(): boolean {
    return this.config?.get<string>('FAST_LANE_SKIP_PREFLIGHT', 'true') === 'true';
  }

  private isFireAndForget(): boolean {
    return this.config?.get<string>('FAST_LANE_FIRE_AND_FORGET', 'true') === 'true';
  }

  async swap(input: SwapInput): Promise<SwapResult> {
    if (!input.fastLane) {
      // ── Security layer: audit, compliance, and risk checks ──
      await this.securityAudit.log('SWAP_INITIATED', {
        userId: input.userId,
        walletId: input.walletId,
        chain: input.chain,
        tokenIn: input.tokenIn,
        tokenOut: input.tokenOut,
        amountIn: input.amountIn,
        notionalUsd: input.notionalUsd,
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
        }, { userId: input.userId });
        throw new ForbiddenException('Wash trade detected — swap blocked by compliance');
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
        }, { userId: input.userId });
        throw new ForbiddenException({
          message: 'Swap blocked by risk engine',
          reasons: riskResult.blockReasons,
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
      if (!decision.ok) throw new ForbiddenException({ guardrail: decision.reason });
    } else {
      // Fast lane: only check kill switch (non-negotiable)
      const guardrailConfig = await this.guardrails.config(input.userId);
      if (guardrailConfig.killSwitch) {
        throw new ForbiddenException('Kill switch active — even fast lane is halted');
      }
      // Fire-and-forget audit (don't await)
      this.securityAudit.log('FAST_LANE_SWAP', {
        userId: input.userId, chain: input.chain,
        tokenIn: input.tokenIn, tokenOut: input.tokenOut,
        amountIn: input.amountIn, notionalUsd: input.notionalUsd,
      }, { userId: input.userId }).catch(() => {});
    }

    const user = await this.prisma.user.findUnique({ where: { id: input.userId } });
    const mode: TradeMode = user?.paperMode ? 'PAPER' : 'LIVE';

    let txHash: string | null = null;
    let outAmount = input.amountIn;

    try {
      if (mode === 'LIVE') {
        if (input.chain === 'SOLANA') {
          // Use optimized fast lane path if enabled
          if (input.fastLane && this.parallelRpc && this.jito && this.priorityFee) {
            const res = await this.executeSolanaFastLane(input);
            txHash = res.txHash;
            outAmount = res.outAmount;
          } else {
            const res = await this.executeSolana(input);
            txHash = res.txHash;
            outAmount = res.outAmount;
          }
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
          this.logger.warn(`Paper mode quote failed (using simulated amount): ${quoteErr.message}`);
          outAmount = input.amountIn; // 1:1 simulated ratio
        }
        txHash = makeSimulatedHash('paper');
        await this.updatePaperBalance(input.userId, input.tokenOut, outAmount);
      }
    } catch (err: any) {
      const isStructured = err instanceof SwapExecutionError;
      const reason = isStructured ? err.reason : err?.code ?? err?.name ?? 'UNKNOWN';
      const context = isStructured ? err.context : {};
      this.logger.error(
        `swap failed user=${input.userId} chain=${input.chain} reason=${reason}: ${err.message}`,
        err.stack,
      );
      await this.prisma.auditLog.create({
        data: {
          userId: input.userId,
          action: 'execution.swap.failed',
          target: input.tokenOut,
          payload: {
            reason,
            message: err.message,
            mode,
            tokenIn: input.tokenIn,
            tokenOut: input.tokenOut,
            amountIn: input.amountIn,
            notionalUsd: input.notionalUsd,
            context,
          } as unknown as Prisma.InputJsonValue,
        },
      });
      if (input.orderId) {
        await this.prisma.order.update({
          where: { id: input.orderId },
          data: { status: OrderStatus.FAILED },
        });
      }
      await this.securityAudit.log('SWAP_FAILED', {
        userId: input.userId,
        reason,
        message: err.message,
        context,
      }, { userId: input.userId }).catch(() => {});
      const failureMessage = formatSwapFailure({
        status: 'FAILED',
        network: getNetworkMode() as SwapNetwork,
        reason,
        message: err.message,
        chain: input.chain,
        tokenIn: input.tokenIn,
        tokenOut: input.tokenOut,
        amountIn: input.amountIn,
        notionalUsd: input.notionalUsd,
        context,
      });
      // Surface a structured HTTP response so API callers see exactly why it failed.
      throw new BadGatewayException({
        error: 'SWAP_FAILED',
        reason,
        message: err.message,
        context,
        chatMessage: failureMessage,
      });
    }

    const side = inferSide(input.chain, input.tokenIn);
    const source = input.source ?? (input.fastLane ? 'FAST_LANE' : 'API');
    const trade = await this.prisma.trade.create({
      data: {
        userId: input.userId,
        orderId: input.orderId,
        chain: input.chain,
        side,
        tokenIn: input.tokenIn,
        tokenOut: input.tokenOut,
        amountIn: input.amountIn,
        amountOut: outAmount,
        priceUsd: input.notionalUsd,
        mode,
        txHash: txHash ?? undefined,
        source,
      },
    });

    // Fast-lane swaps don't go through OrderManager so they have no Order row.
    // Synthesize one so the activity feed sees them as first-class orders.
    if (input.fastLane && !input.orderId) {
      try {
        await this.prisma.order.create({
          data: {
            userId: input.userId,
            walletId: input.walletId,
            type: 'MARKET' as any,
            status: txHash ? ('FILLED' as any) : ('FAILED' as any),
            chain: input.chain,
            tokenIn: input.tokenIn,
            tokenOut: input.tokenOut,
            amountIn: input.amountIn,
            params: { fastLane: true, notionalUsd: input.notionalUsd } as any,
            txHash: txHash ?? undefined,
            source,
          },
        });
      } catch (e: any) {
        // Non-fatal — the trade itself is the source of truth.
        this.logger.warn(`fast-lane order shadow create failed: ${e.message}`);
      }
    }
    if (input.orderId) {
      await this.prisma.order.update({
        where: { id: input.orderId },
        data: { status: OrderStatus.FILLED, txHash: txHash ?? undefined },
      });
    }

    // Security: record order for compliance tracking (skip in fast lane)
    if (!input.fastLane) {
      const postOrderAction: PlaceOrderAction = {
        type: AgentActionType.PlaceOrder,
        instrument: `${input.tokenIn}-${input.tokenOut}`,
        side: OrderSide.BUY,
        orderType: OrderType.MARKET,
        quantity: parseFloat(input.amountIn) || 0,
        strategyId: 'swap',
        clientOrderId: input.orderId ?? crypto.randomUUID(),
      };
      await this.securityCompliance.recordOrder(postOrderAction, input.userId);
    }
    await this.securityAudit.log('SWAP_COMPLETED', {
      userId: input.userId,
      tradeId: trade.id,
      txHash,
      mode,
      tokenIn: input.tokenIn,
      tokenOut: input.tokenOut,
      amountIn: input.amountIn,
      amountOut: outAmount,
      fastLane: input.fastLane ?? false,
    }, { userId: input.userId }).catch(() => {});

    await this.dna.recordTrade(input.userId, { pnlUsd: 0, holdMinutes: 0 });
    this.emotional.evaluate(input.userId).catch((e) => this.logger.warn(`Emotional eval failed: ${e.message}`));
    await this.prisma.auditLog.create({
      data: {
        userId: input.userId,
        action: 'execution.swap',
        target: input.tokenOut,
        payload: { mode, txHash, fastLane: input.fastLane ?? false } as unknown as Prisma.InputJsonValue,
      },
    });

    // ─── Build status, explorer URL, and the user-facing chat message ───
    const network: SwapNetwork = isTestnet() ? 'testnet' : 'mainnet';
    const isPaperHash = !!txHash && txHash.startsWith(PAPER_PREFIX);
    const isTestnetSimHash = !!txHash && txHash.startsWith(SOL_SIM_PREFIX);
    const simulated = mode === 'PAPER' || isTestnetSimHash;

    let status: SwapStatus;
    if (mode === 'PAPER') {
      status = 'SIMULATED_PAPER';
    } else if (isTestnetSimHash) {
      status = 'SIMULATED_TESTNET';
    } else if (input.fastLane && this.isFireAndForget()) {
      status = 'SUBMITTED';
    } else {
      status = 'CONFIRMED';
    }

    const realOnChain = !!txHash && !isPaperHash && !isTestnetSimHash && mode === 'LIVE';
    const explorerUrl = realOnChain
      ? (input.chain === 'SOLANA'
          ? getSolanaExplorerUrl(txHash!)
          : getEvmExplorerUrl(this.resolveEvmChainId(input), txHash!))
      : null;
    const explorerLabel = realOnChain
      ? (input.chain === 'SOLANA' ? 'Solscan' : 'block explorer')
      : null;

    const successPayload: SwapSuccessPayload = {
      status: status as Exclude<SwapStatus, 'FAILED'>,
      simulated,
      network,
      mode,
      side,
      chain: input.chain,
      tokenIn: input.tokenIn,
      tokenOut: input.tokenOut,
      amountIn: input.amountIn,
      amountOut: outAmount,
      notionalUsd: input.notionalUsd,
      txHash: txHash ?? '',
      explorerUrl,
      explorerLabel,
    };
    const message = formatSwapSuccess(successPayload);

    return {
      tradeId: trade.id,
      status,
      simulated,
      network,
      mode,
      side,
      chain: input.chain,
      tokenIn: input.tokenIn,
      tokenOut: input.tokenOut,
      amountIn: input.amountIn,
      amountOut: outAmount,
      notionalUsd: input.notionalUsd,
      txHash,
      explorerUrl,
      explorerLabel,
      message,
    };
  }

  async multiWalletBuy(userId: string, walletIds: string[], input: Omit<SwapInput, 'userId' | 'walletId'>): Promise<SwapResult[]> {
    const results: SwapResult[] = [];
    for (const walletId of walletIds) {
      try {
        const result = await this.swap({ ...input, userId, walletId });
        results.push(result);
      } catch (e: any) {
        this.logger.warn(`Multi-wallet buy wallet=${walletId} failed: ${e.message}`);
        const reason = e?.response?.reason ?? e?.reason ?? 'UNKNOWN';
        const failureMessage = formatSwapFailure({
          status: 'FAILED',
          network: getNetworkMode() as SwapNetwork,
          reason,
          message: e?.message ?? 'unknown',
          chain: input.chain,
          tokenIn: input.tokenIn,
          tokenOut: input.tokenOut,
          amountIn: input.amountIn,
          notionalUsd: input.notionalUsd,
        });
        results.push({
          tradeId: '',
          status: 'FAILED',
          simulated: false,
          network: getNetworkMode() as SwapNetwork,
          mode: 'LIVE' as TradeMode,
          side: inferSide(input.chain, input.tokenIn),
          chain: input.chain,
          tokenIn: input.tokenIn,
          tokenOut: input.tokenOut,
          amountIn: input.amountIn,
          amountOut: '0',
          notionalUsd: input.notionalUsd,
          txHash: null,
          explorerUrl: null,
          explorerLabel: null,
          message: failureMessage,
        });
      }
    }
    return results;
  }

  /**
   * Lightning-fast Solana execution path for fast lane trades.
   *
   * Optimizations applied:
   *  - Skip /quote if a fresh cached price exists (saves 200-400ms)
   *  - Use parallel RPC submission (saves 100-300ms)
   *  - Use Jito bundle with tip (saves 200-400ms + priority inclusion)
   *  - Priority fee auto-tuned to p99 (guaranteed next-block inclusion under congestion)
   *  - skipPreflight=true (saves 50-100ms)
   *  - Fire-and-forget confirmation (saves 400-1200ms)
   *
   * Expected total latency: ~150-400ms vs ~800-2500ms for normal path.
   */
  private async executeSolanaFastLane(input: SwapInput): Promise<{ txHash: string; outAmount: string }> {
    const start = Date.now();
    const wallet = await this.prisma.wallet.findFirst({
      where: { id: input.walletId, userId: input.userId },
    });
    if (!wallet) throw new ForbiddenException();

    const telemetry: FastLaneTelemetry = {
      usedUndiciPool: true,
      usedJito: this.jito?.isEnabled() ?? false,
      usedParallelRpc: this.parallelRpc?.isEnabled() ?? false,
      skippedPreflight: this.isSkipPreflight(),
      skippedQuote: false,
      fireAndForget: this.isFireAndForget(),
      priorityFeeMicroLamports: 0,
      jitoTipLamports: this.jito?.isEnabled() ? this.jito.getTipLamports() : 0,
      totalMs: 0,
    };

    // Step 1: Try cached price to skip quote
    let outAmountEstimate = input.amountIn;
    const tokenOutKey = input.tokenOut;
    if (this.priceCache?.isSkipQuoteEnabled() && this.priceCache.isFresh(tokenOutKey)) {
      const minOut = this.priceCache.computeMinOut(tokenOutKey, input.notionalUsd, input.slippageBps);
      if (minOut !== null) {
        telemetry.skippedQuote = true;
        outAmountEstimate = String(Math.floor(minOut));
        this.logger.log(`[FastLane] skipped quote using cached price for ${tokenOutKey}`);
      }
    }

    // Step 2: Build the swap tx via Jupiter (we still need Jupiter to build the routed tx,
    //         but we skipped the separate /quote call above when possible)
    const quote = telemetry.skippedQuote
      ? null
      : await this.jup.quote(input.tokenIn, input.tokenOut, input.amountIn, input.slippageBps);
    const quoteForSwap = quote ?? (await this.jup.quote(input.tokenIn, input.tokenOut, input.amountIn, input.slippageBps));
    const swap = await this.jup.swapTx(quoteForSwap, wallet.address, true);

    if (!swap?.swapTransaction) {
      if (!isTestnet() || !swap?.testnetMock) {
        throw new SwapExecutionError(
          'Jupiter did not return a signable swap transaction',
          'JUPITER_NO_SWAP_TX',
          {
            provider: 'jupiter',
            network: getNetworkMode(),
            tokenIn: input.tokenIn,
            tokenOut: input.tokenOut,
            amountIn: input.amountIn,
            notionalUsd: input.notionalUsd,
            rawResponse: swap,
          },
        );
      }
      // Pure testnet simulation: synthetic hash, no chain calls, no signing.
      // Jupiter has no devnet API, so the previous self-transfer fallback was
      // misleading (the user thought a "buy" had executed when it was just a
      // self-send). We now never touch the chain on testnet.
      const txHash = makeSimulatedHash('testnet');
      telemetry.totalMs = Date.now() - start;
      this.logger.log(`[FastLane] testnet simulated hash=${txHash} totalMs=${telemetry.totalMs} ${JSON.stringify(telemetry)}`);
      return { txHash, outAmount: quoteForSwap.outAmount };
    }

    // Step 3: Build compute budget + priority fee instructions
    let priorityInstructions: import('@solana/web3.js').TransactionInstruction[] = [];
    if (this.priorityFee) {
      try {
        priorityInstructions = await this.priorityFee.buildComputeBudgetInstructions('p99');
        telemetry.priorityFeeMicroLamports = await this.priorityFee.getFeeMicroLamports('p99');
      } catch (e: any) {
        this.logger.warn(`Priority fee computation failed: ${e.message}`);
      }
    }

    // Step 4: Deserialize, optionally add priority + Jito tip, sign
    const swapTxB64: string = swap.swapTransaction;
    const result = await this.wallets.withSigningKey(input.userId, input.walletId, async (key) => {
      const kp = Keypair.fromSecretKey(new Uint8Array(key));
      const raw = Buffer.from(swapTxB64, 'base64');
      let versioned = VersionedTransaction.deserialize(raw);

      // Inject priority fee + Jito tip if configured
      // (Jupiter's swap tx is already built, so we need to rebuild the message)
      if (priorityInstructions.length > 0 || telemetry.usedJito) {
        try {
          const primaryConn = this.parallelRpc?.primaryConnection() ?? new Connection(getSolanaRpcUrl(), 'confirmed');
          const latest = await primaryConn.getLatestBlockhash('confirmed');

          // Decompile existing message to get instructions
          const addressLookupTableAccounts: import('@solana/web3.js').AddressLookupTableAccount[] = [];
          for (const lookup of versioned.message.addressTableLookups) {
            const lookupAccount = await primaryConn.getAddressLookupTable(lookup.accountKey);
            if (lookupAccount.value) addressLookupTableAccounts.push(lookupAccount.value);
          }
          const decompiled = TransactionMessage.decompile(versioned.message, { addressLookupTableAccounts });

          const extraInstructions = [...priorityInstructions];
          if (telemetry.usedJito && this.jito) {
            extraInstructions.push(this.jito.buildTipInstruction(kp.publicKey));
          }

          const newMessage = new TransactionMessage({
            payerKey: kp.publicKey,
            recentBlockhash: latest.blockhash,
            instructions: [...extraInstructions, ...decompiled.instructions],
          });

          versioned = new VersionedTransaction(newMessage.compileToV0Message(addressLookupTableAccounts));
        } catch (e: any) {
          // If we can't inject extras, just proceed with the original tx
          this.logger.warn(`[FastLane] Failed to inject priority/jito, using original tx: ${e.message}`);
        }
      }

      versioned.sign([kp]);
      const wire = versioned.serialize();
      const wireB64 = Buffer.from(wire).toString('base64');

      // Step 5: Submit — Jito first if enabled, else parallel RPC
      let signature: string | undefined;
      let winningRpc: string | undefined;

      if (telemetry.usedJito && this.jito) {
        try {
          const bundleId = await this.jito.sendBundle([wireB64]);
          telemetry.jitoBundleId = bundleId;
          // Jito bundles don't return a signature directly — derive it from the tx
          signature = bs58.encode(versioned.signatures[0]!);
          winningRpc = 'jito';
        } catch (e: any) {
          this.logger.warn(`[FastLane] Jito failed, falling back to RPC: ${e.message}`);
        }
      }

      if (!signature && this.parallelRpc) {
        const sendRes = await this.parallelRpc.sendParallel(wire, {
          skipPreflight: telemetry.skippedPreflight,
          maxRetries: 0,
          preflightCommitment: 'processed',
        });
        signature = sendRes.signature;
        winningRpc = sendRes.winningRpc;
      }

      if (!signature) {
        // Fallback: single RPC
        const conn = new Connection(getSolanaRpcUrl(), 'confirmed');
        signature = await conn.sendRawTransaction(wire, {
          skipPreflight: telemetry.skippedPreflight,
          maxRetries: 0,
        });
        winningRpc = 'default';
      }

      telemetry.winningRpc = winningRpc;
      return { signature, versioned };
    });

    const signature: string = result.signature!;

    // Step 6: Fire-and-forget confirmation (return signature immediately)
    if (telemetry.fireAndForget) {
      // Confirm in background — log result but don't block
      this.confirmAsync(signature, input.userId, input.orderId).catch((e) => {
        this.logger.warn(`[FastLane] async confirm failed for ${signature}: ${e.message}`);
      });
      telemetry.totalMs = Date.now() - start;
      this.logger.log(`[FastLane] fire-and-forget signature=${signature} totalMs=${telemetry.totalMs}ms telemetry=${JSON.stringify(telemetry)}`);
      return { txHash: signature, outAmount: quoteForSwap.outAmount };
    }

    // Otherwise wait for confirmation
    if (this.parallelRpc) {
      await this.parallelRpc.confirmSignature(signature, 30000);
    } else {
      const conn = new Connection(getSolanaRpcUrl(), 'confirmed');
      const latest = await conn.getLatestBlockhash('confirmed');
      await conn.confirmTransaction({ signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, 'confirmed');
    }
    telemetry.totalMs = Date.now() - start;
    this.logger.log(`[FastLane] confirmed signature=${signature} totalMs=${telemetry.totalMs}ms telemetry=${JSON.stringify(telemetry)}`);
    return { txHash: signature, outAmount: quoteForSwap.outAmount };
  }

  /**
   * Async confirmation for fire-and-forget fast lane swaps.
   * Updates the trade record with confirmation status, emits notification.
   */
  private async confirmAsync(signature: string, userId: string, orderId?: string): Promise<void> {
    if (!this.parallelRpc) return;
    const confirmed = await this.parallelRpc.confirmSignature(signature, 60000);
    if (confirmed) {
      this.logger.log(`[FastLane] async confirmed: ${signature} user=${userId}`);
      if (orderId) {
        await this.prisma.order.update({
          where: { id: orderId },
          data: { status: OrderStatus.FILLED, txHash: signature },
        }).catch(() => {});
      }
    } else {
      this.logger.warn(`[FastLane] async confirm timeout: ${signature} user=${userId}`);
      if (orderId) {
        await this.prisma.order.update({
          where: { id: orderId },
          data: { status: OrderStatus.FAILED },
        }).catch(() => {});
      }
    }
  }

  private async executeSolana(input: SwapInput): Promise<{ txHash: string; outAmount: string }> {
    const wallet = await this.prisma.wallet.findFirst({
      where: { id: input.walletId, userId: input.userId },
    });
    if (!wallet) throw new ForbiddenException();

    const quote = await this.jup.quote(input.tokenIn, input.tokenOut, input.amountIn, input.slippageBps);
    const swap = await this.jup.swapTx(quote, wallet.address, true);

    const rpcUrl = getSolanaRpcUrl();
    const connection = new Connection(rpcUrl, 'confirmed');

    // Pure testnet simulation: Jupiter has no devnet API, so we never touch
    // the chain on testnet. The previous self-transfer fallback was a footgun
    // — a "buy" that silently became a self-send. On mainnet a missing
    // swapTransaction is a hard failure, not a fallback.
    if (!swap?.swapTransaction) {
      if (!isTestnet() || !swap?.testnetMock) {
        throw new SwapExecutionError(
          'Jupiter did not return a signable swap transaction',
          'JUPITER_NO_SWAP_TX',
          {
            provider: 'jupiter',
            network: getNetworkMode(),
            tokenIn: input.tokenIn,
            tokenOut: input.tokenOut,
            amountIn: input.amountIn,
            notionalUsd: input.notionalUsd,
            rawResponse: swap,
          },
        );
      }
      const txHash = makeSimulatedHash('testnet');
      this.logger.log(`[testnet] simulated Solana swap hash=${txHash}`);
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

    // Pure testnet simulation: 1inch has no testnet API, so we never touch
    // the chain on testnet. On mainnet, missing calldata is a hard failure.
    if (!swap?.tx?.data) {
      if (!isTestnet() || !swap?.testnetMock) {
        throw new SwapExecutionError(
          '1inch did not return signable swap calldata',
          'ONEINCH_NO_CALLDATA',
          {
            provider: '1inch',
            network: getNetworkMode(),
            chainId,
            tokenIn: input.tokenIn,
            tokenOut: input.tokenOut,
            amountIn: input.amountIn,
            notionalUsd: input.notionalUsd,
            rawResponse: swap,
          },
        );
      }
      const txHash = makeSimulatedHash('testnet');
      this.logger.log(`[testnet] simulated EVM swap hash=${txHash}`);
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
