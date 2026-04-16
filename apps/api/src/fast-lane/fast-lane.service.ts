import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Chain } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ExecutionService, SwapInput, SwapResult } from '../execution/execution.service';
import { NotificationsService } from '../agents/notifications.service';
import { PerformanceTracker, PerfReport } from './performance-tracker';

export interface FastLaneSwapInput {
  tokenOut: string;
  amountUsd: number;
  walletId?: string;
  chain?: Chain;
  slippageBps?: number;
  tokenIn?: string;
}

export interface FastLaneResult extends SwapResult {
  perfReport: PerfReport;
}

/** USDC mint on Solana */
const SOLANA_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

@Injectable()
export class FastLaneService {
  private readonly logger = new Logger(FastLaneService.name);

  /** In-memory ring buffer for recent perf reports, keyed by userId */
  private readonly perfRing = new Map<string, PerfReport[]>();
  private readonly MAX_RING = 100;

  constructor(
    private prisma: PrismaService,
    @Inject(forwardRef(() => ExecutionService))
    private execution: ExecutionService,
    private config: ConfigService,
    private notifications: NotificationsService,
  ) {}

  // ────────────────────────── swap ──────────────────────────

  async executeFastSwap(
    userId: string,
    input: FastLaneSwapInput,
    channel: string,
  ): Promise<FastLaneResult> {
    const perf = new PerformanceTracker();
    perf.mark('request_received');

    // 1. Global env kill-switch
    const envEnabled = this.config.get<string>('FAST_LANE_ENABLED', 'true');
    if (envEnabled === 'false') {
      throw new ForbiddenException('Fast Lane is disabled globally');
    }

    // 2. Load (or create) per-user config
    const cfg = await this.getConfig(userId);
    perf.mark('config_loaded');

    // 3. Config-level enabled flag
    if (!cfg.enabled) {
      throw new ForbiddenException('Fast Lane is not enabled for your account');
    }

    // 4. Channel trust check
    if (cfg.trustedChannels.length > 0 && !cfg.trustedChannels.includes(channel)) {
      throw new ForbiddenException(
        `Channel "${channel}" is not in your trusted channels: ${cfg.trustedChannels.join(', ')}`,
      );
    }

    // 5. Allowed tokens check
    if (cfg.allowedTokens.length > 0 && !cfg.allowedTokens.includes(input.tokenOut)) {
      throw new ForbiddenException(
        `Token ${input.tokenOut} is not in your fast-lane allowed tokens`,
      );
    }

    // 6. Daily cap
    const todayMidnight = new Date();
    todayMidnight.setHours(0, 0, 0, 0);

    const dayAgg = await this.prisma.trade.aggregate({
      _sum: { priceUsd: true },
      where: {
        userId,
        mode: 'LIVE',
        createdAt: { gte: todayMidnight },
      },
    });
    const dayUsed = dayAgg._sum.priceUsd ?? 0;
    if (dayUsed + input.amountUsd > cfg.maxDailyUsd) {
      throw new ForbiddenException(
        `Fast Lane daily cap exceeded: used $${dayUsed.toFixed(2)} of $${cfg.maxDailyUsd}`,
      );
    }

    // 7. Per-trade cap
    if (input.amountUsd > cfg.maxPerTradeUsd) {
      throw new ForbiddenException(
        `Amount $${input.amountUsd} exceeds fast-lane per-trade cap of $${cfg.maxPerTradeUsd}`,
      );
    }

    perf.mark('safety_checked');

    // 8. Build SwapInput
    const chain: Chain = input.chain ?? 'SOLANA';
    const tokenIn =
      input.tokenIn ??
      (chain === 'SOLANA' ? SOLANA_USDC : 'USDC');

    const swapInput: SwapInput = {
      userId,
      walletId: input.walletId ?? cfg.defaultWalletId ?? '',
      chain,
      tokenIn,
      tokenOut: input.tokenOut,
      amountIn: String(input.amountUsd),
      notionalUsd: input.amountUsd,
      slippageBps: input.slippageBps ?? cfg.defaultSlippageBps,
      fastLane: true,
    };

    // 9. Execute
    const result = await this.execution.swap(swapInput);
    perf.mark('swap_complete');

    // 10. Finalize perf report
    perf.setMeta(result.tradeId, channel);
    const perfReport = perf.report();

    // Log perf (fire-and-forget)
    this.logger.log(
      `Fast Lane swap completed: tradeId=${result.tradeId} totalMs=${perfReport.totalMs.toFixed(1)} channel=${channel}`,
    );
    this.storePerfReport(userId, perfReport);

    // 11. Notify user (fire-and-forget)
    this.notifications
      .emit({
        userId,
        kind: 'FAST_LANE_FILL',
        payload: {
          tradeId: result.tradeId,
          tokenOut: input.tokenOut,
          amountUsd: input.amountUsd,
          txHash: result.txHash,
          totalMs: Math.round(perfReport.totalMs),
          channel,
        },
      })
      .catch((e) => this.logger.warn(`Fast Lane notification failed: ${e.message}`));

    return { ...result, perfReport };
  }

  // ────────────────────────── config ──────────────────────────

  async getConfig(userId: string) {
    return this.prisma.fastLaneConfig.upsert({
      where: { userId },
      update: {},
      create: {
        userId,
        enabled: false,
        trustedChannels: [],
        allowedTokens: [],
        maxPerTradeUsd: 500,
        maxDailyUsd: 2000,
        defaultSlippageBps: 200,
      },
    });
  }

  async updateConfig(
    userId: string,
    patch: Partial<{
      enabled: boolean;
      trustedChannels: string[];
      maxPerTradeUsd: number;
      maxDailyUsd: number;
      defaultSlippageBps: number;
      defaultWalletId: string;
      allowedTokens: string[];
      skipWashTradeCheck: boolean;
      skipRiskEngine: boolean;
      skipGuardrails: boolean;
      skipInjectionDetect: boolean;
      skipDuplicateDetect: boolean;
    }>,
  ) {
    // Ensure config row exists
    await this.getConfig(userId);
    return this.prisma.fastLaneConfig.update({
      where: { userId },
      data: patch,
    });
  }

  // ────────────────────────── metrics ──────────────────────────

  getMetrics(userId: string): PerfReport[] {
    return this.perfRing.get(userId) ?? [];
  }

  private storePerfReport(userId: string, report: PerfReport) {
    let ring = this.perfRing.get(userId);
    if (!ring) {
      ring = [];
      this.perfRing.set(userId, ring);
    }
    ring.push(report);
    if (ring.length > this.MAX_RING) {
      ring.splice(0, ring.length - this.MAX_RING);
    }
  }
}
