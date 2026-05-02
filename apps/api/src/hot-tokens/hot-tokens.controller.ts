import { BadRequestException, Body, Controller, Get, NotFoundException, Post, Query, Req, Optional, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { ExecutionService } from '../execution/execution.service';
import { HotTokensService } from './hot-tokens.service';
import { SignalPipelineService } from './signal-pipeline.service';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const AUTO_BUY_ENABLED = process.env.SIGNAL_AUTO_BUY_ENABLED !== 'false';
const DEFAULT_SLIPPAGE_BPS = 300;

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

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('scan')
  async triggerScan() {
    void this.svc.scan();
    return { triggered: true, ts: new Date().toISOString() };
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
