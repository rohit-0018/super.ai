import {
  Body,
  Controller,
  Get,
  Headers,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { TelegramLinkService } from '../auth/telegram-link.service';
import { FastLaneService, FastLaneSwapInput } from './fast-lane.service';

// ───────────────── DTOs ─────────────────

interface SwapBody {
  tokenOut: string;
  amountUsd: number;
  walletId?: string;
  chain?: any;
  slippageBps?: number;
  tokenIn?: string;
}

interface TelegramBody {
  telegramChatId: string;
  command: string; // e.g. "/buy BONK 200"
}

// ───────────────── Controller ─────────────────

@Controller('fast-lane')
export class FastLaneController {
  constructor(
    private fastLane: FastLaneService,
    private telegramLink: TelegramLinkService,
  ) {}

  // ── Protected endpoints (JWT) ──────────────────

  @UseGuards(JwtAuthGuard)
  @Post('swap')
  async swap(
    @Req() req: any,
    @Body() body: SwapBody,
    @Headers('x-channel') channel?: string,
  ) {
    const input: FastLaneSwapInput = {
      tokenOut: body.tokenOut,
      amountUsd: body.amountUsd,
      walletId: body.walletId,
      chain: body.chain,
      slippageBps: body.slippageBps,
      tokenIn: body.tokenIn,
    };
    return this.fastLane.executeFastSwap(
      req.user.userId,
      input,
      channel || 'web',
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get('config')
  getConfig(@Req() req: any) {
    return this.fastLane.getConfig(req.user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('config')
  updateConfig(@Req() req: any, @Body() body: any) {
    return this.fastLane.updateConfig(req.user.userId, body);
  }

  @UseGuards(JwtAuthGuard)
  @Get('metrics')
  getMetrics(@Req() req: any) {
    return this.fastLane.getMetrics(req.user.userId);
  }

  // ── Telegram endpoint (no JWT — authenticated by chatId lookup) ──

  @Post('telegram')
  async telegram(@Body() body: TelegramBody) {
    const userId = await this.telegramLink.resolveByChatId(body.telegramChatId);
    if (!userId) {
      throw new UnauthorizedException(
        'Telegram account not linked. Use /link <code> to connect.',
      );
    }

    const parsed = this.parseTelegramCommand(body.command);
    return this.fastLane.executeFastSwap(userId, parsed, 'telegram');
  }

  // ── Helpers ──

  /**
   * Parse a Telegram command string into FastLaneSwapInput.
   * Supported formats:
   *   /buy BONK 200
   *   /buy BONK 200 50   (50 = slippageBps)
   */
  private parseTelegramCommand(command: string): FastLaneSwapInput {
    const parts = command.trim().split(/\s+/);
    // Remove leading /buy or /swap if present
    if (parts[0]?.startsWith('/')) parts.shift();

    const tokenOut = parts[0];
    const amountUsd = parseFloat(parts[1]);

    if (!tokenOut || isNaN(amountUsd)) {
      throw new UnauthorizedException(
        'Invalid command format. Use: /buy <TOKEN> <AMOUNT_USD> [SLIPPAGE_BPS]',
      );
    }

    const slippageBps = parts[2] ? parseInt(parts[2], 10) : undefined;

    return { tokenOut, amountUsd, slippageBps };
  }
}
