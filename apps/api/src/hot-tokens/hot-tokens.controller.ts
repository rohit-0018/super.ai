import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Query, Req, Optional, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsArray, IsNumber, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { ExecutionService } from '../execution/execution.service';
import { HotTokensService } from './hot-tokens.service';
import { SignalPipelineService } from './signal-pipeline.service';
import { TokenPoolService } from './token-pool.service';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const AUTO_BUY_ENABLED = process.env.SIGNAL_AUTO_BUY_ENABLED !== 'false';
const DEFAULT_SLIPPAGE_BPS = 300;

class AnalyzeItemDto {
  @IsString() address!: string;
  @IsString() symbol!: string;
  @IsOptional() @IsString() profileKey?: string;
}

class AnalyzeBatchDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AnalyzeItemDto)
  items!: AnalyzeItemDto[];
}

class SignalBuyDto {
  @IsString() address!: string;
  @IsNumber() @Min(1) amountUsd!: number;
  @IsNumber() @IsOptional() solPriceUsd?: number;
}

@Controller('hot-tokens')
export class HotTokensController {
  constructor(
    private readonly svc: HotTokensService,
    @Optional() private readonly pipeline: SignalPipelineService,
    @Optional() private readonly exec: ExecutionService,
    private readonly prisma: PrismaService,
    @Optional() private readonly pool: TokenPoolService,
  ) {}

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get()
  getLatest(@Query('profile') profile?: string) {
    const key = profile ?? 'meme_hunter';
    const scan = this.svc.getLatest(key);
    if (!scan) return { tokens: [], profileKey: key, scannedAt: null, nextScanAt: null, scanIntervalMs: 60_000, fastScanEnabled: this.svc.fastScan };
    return scan;
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('all')
  getAllProfiles() {
    return this.svc.getAllLatest() ?? { byProfile: {}, scannedAt: null, nextScanAt: null, scanIntervalMs: 60_000 };
  }

  /** Latest signal-pipeline results — hydrates clients on page load */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('signals')
  getSignals(@Query('minScore') minScore?: string) {
    const all = this.pipeline?.getAll() ?? [];
    const threshold = minScore ? parseInt(minScore, 10) : 0;
    return threshold > 0 ? all.filter((r) => r.score >= threshold) : all;
  }

  /**
   * POST /api/hot-tokens/signals/analyze
   * Frontend sends unanalyzed card addresses; we enqueue them in the pipeline.
   * Results arrive via the `signal_analysis` WS event — no polling needed.
   */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('signals/analyze')
  analyzeAddresses(@Body() dto: AnalyzeBatchDto) {
    const queued = this.pipeline?.enqueueBatch(dto.items) ?? 0;
    return { queued };
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('scan')
  async triggerScan() {
    void this.svc.scan();
    return { triggered: true, ts: new Date().toISOString() };
  }

  /** GET /api/hot-tokens/pool — single source of truth for all tracked token live prices */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('pool')
  getPool() {
    return this.pool?.getSnapshot() ?? { entries: {}, refreshedAt: null, activeCount: 0, archivedCount: 0 };
  }

  /** POST /api/hot-tokens/pool/archive/:address — stop refreshing a stale token */
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('pool/archive/:address')
  archiveToken(@Param('address') address: string) {
    if (!address) throw new BadRequestException('address required');
    this.pool?.archiveAddress(address);
    return { ok: true, address };
  }

  /** POST /api/hot-tokens/pool/refresh — force an immediate pool refresh */
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('pool/refresh')
  async triggerPoolRefresh() {
    void this.pool?.refresh();
    return { triggered: true, ts: new Date().toISOString() };
  }

  /**
   * GET /api/hot-tokens/verdicts/:address
   * Full verdict history for a token — newest first.
   * Powers score-over-time charts and exit-engine thesis-break detection.
   */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('verdicts/:address')
  async getVerdictHistory(
    @Param('address') address: string,
    @Query('limit') limit?: string,
  ) {
    const take = Math.min(parseInt(limit ?? '50', 10), 200);
    const rows = await this.prisma.verdictHistory.findMany({
      where: { address },
      orderBy: { analyzedAt: 'desc' },
      take,
      select: {
        id: true, analyzedAt: true, aiScore: true, aiVerdict: true,
        priceUsd: true, marketCapUsd: true,
        t1Pct: true, t2Pct: true, stopLossPct: true, riskReward: true,
        aiSummary: true, bullishSignals: true, riskFactors: true,
        source: true, profileKey: true, latencyMs: true,
      },
    });
    return { address, count: rows.length, history: rows };
  }

  /**
   * POST /api/hot-tokens/signal-buy
   * Auto-buy endpoint called by the SignalBanner when autoBuy=true.
   * Picks the user's first Solana wallet and executes a SOL → token swap.
   * Guards: SIGNAL_AUTO_BUY_ENABLED env var + JwtAuthGuard.
   */
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('signal-buy')
  async signalBuy(@Req() req: any, @Body() dto: SignalBuyDto) {
    if (!AUTO_BUY_ENABLED) {
      throw new BadRequestException('Signal auto-buy is disabled on this server (SIGNAL_AUTO_BUY_ENABLED=false)');
    }
    if (!this.exec) {
      throw new BadRequestException('Execution service unavailable');
    }

    const userId: string = req.user.userId;

    // Find the user's primary Solana wallet
    const wallet = await this.prisma.wallet.findFirst({
      where: { userId, chain: 'SOLANA' },
      orderBy: { createdAt: 'asc' },
    });
    if (!wallet) throw new NotFoundException('No Solana wallet found — create one first');

    // Convert USD → lamports. Frontend can pass current SOL price for accuracy;
    // fallback to a conservative $140 so the amount is at least in the right ballpark.
    const solPrice = dto.solPriceUsd ?? 140;
    const solAmount = dto.amountUsd / solPrice;
    const lamports = Math.floor(solAmount * 1_000_000_000).toString();

    const result = await this.exec.swap({
      userId,
      walletId: wallet.id,
      chain: 'SOLANA',
      tokenIn: SOL_MINT,
      tokenOut: dto.address,
      amountIn: lamports,
      notionalUsd: dto.amountUsd,
      slippageBps: DEFAULT_SLIPPAGE_BPS,
      strategyId: 'signal_auto_buy',
    });

    return { ok: true, ...result };
  }
}
