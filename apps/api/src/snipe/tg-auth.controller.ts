import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { TgAuthService } from './tg-auth.service';
import { TgUserbotService } from './tg-userbot.service';

function humanizeTgError(e: any, step: string): string {
  const raw: string = e?.errorMessage ?? e?.text ?? e?.message ?? '';
  if (/FLOOD_WAIT_(\d+)/.test(raw)) {
    const secs = parseInt(raw.match(/FLOOD_WAIT_(\d+)/)?.[1] ?? '0', 10);
    const mins = Math.ceil(secs / 60);
    return secs < 60
      ? `Too many attempts — Telegram says wait ${secs}s before trying again.`
      : `Too many attempts — Telegram has blocked this number for ${mins} minute${mins > 1 ? 's' : ''}. Please wait before retrying.`;
  }
  if (raw.includes('PHONE_NUMBER_INVALID')) return 'Invalid phone number — include your country code (e.g. +91 for India, +1 for US).';
  if (raw.includes('PHONE_NUMBER_BANNED')) return 'This phone number is banned from Telegram.';
  if (raw.includes('PHONE_CODE_INVALID')) return 'Wrong code — check your Telegram app and try again.';
  if (raw.includes('PHONE_CODE_EXPIRED')) return 'Code expired — request a new one.';
  if (raw.includes('PASSWORD_HASH_INVALID')) return 'Wrong 2FA password.';
  if (raw.includes('API_ID_INVALID') || raw.includes('API_ID_PUBLISHED_FLOOD')) return 'Telegram API credentials are invalid — check TELEGRAM_API_ID and TELEGRAM_API_HASH in .env.';
  if (raw.includes('NETWORK') || raw.includes('connection')) return 'Could not connect to Telegram — check server network.';
  return raw || `${step} failed`;
}

class SendCodeDto {
  @IsString() @MinLength(7)
  phoneNumber!: string;
}
class VerifyCodeDto {
  @IsString() @MinLength(4)
  code!: string;
}
class Verify2faDto {
  @IsString() @MinLength(1)
  password!: string;
}

@UseGuards(JwtAuthGuard)
@Controller('snipe/tg')
export class TgAuthController {
  constructor(
    private auth: TgAuthService,
    private userbot: TgUserbotService,
  ) {}

  /** GET /api/snipe/tg/status */
  @Get('status')
  async status(@Req() req: any) {
    const userId: string = req.user.userId;
    let connected = this.userbot.isConnected(userId);
    const me = connected ? await this.userbot.getMe(userId) : null;
    // Kick background reconnect if session exists in DB but client is not live.
    if (!connected) this.userbot.ensureConnected(userId).catch(() => {});
    return { connected, me, qrPending: this.auth.hasQrPending(userId) };
  }

  // ── QR login ───────────────────────────────────────────────────────────────

  /** POST /api/snipe/tg/qr/start — begin QR login, returns once first QR URL is ready */
  @Post('qr/start')
  async startQr(@Req() req: any) {
    try {
      return await this.auth.startQrLogin(req.user.userId);
    } catch (e: any) {
      throw new BadRequestException(e.message ?? 'Failed to start QR login');
    }
  }

  /** GET /api/snipe/tg/qr/poll — frontend polls this every 2-3 s while showing QR */
  @Get('qr/poll')
  async pollQr(@Req() req: any) {
    try {
      return await this.auth.pollQrLogin(req.user.userId);
    } catch (e: any) {
      throw new BadRequestException(e.message ?? 'Poll failed');
    }
  }

  /** POST /api/snipe/tg/qr/verify-2fa — submit 2FA password if needed after QR scan */
  @Post('qr/verify-2fa')
  async qrVerify2fa(@Req() req: any, @Body() dto: Verify2faDto) {
    try {
      await this.auth.submitQr2fa(req.user.userId, dto.password);
      return { ok: true };
    } catch (e: any) {
      throw new BadRequestException(e.message ?? '2FA failed');
    }
  }

  /** DELETE /api/snipe/tg/qr/cancel */
  @Delete('qr/cancel')
  cancelQr(@Req() req: any) {
    this.auth.cancelQrLogin(req.user.userId);
    return { ok: true };
  }

  // ── Phone login (fallback) ─────────────────────────────────────────────────

  /** POST /api/snipe/tg/send-code */
  @Post('send-code')
  async sendCode(@Req() req: any, @Body() dto: SendCodeDto) {
    try {
      return await this.auth.sendCode(req.user.userId, dto.phoneNumber);
    } catch (e: any) {
      throw new BadRequestException(humanizeTgError(e, 'send-code'));
    }
  }

  /** POST /api/snipe/tg/verify-code */
  @Post('verify-code')
  async verifyCode(@Req() req: any, @Body() dto: VerifyCodeDto) {
    try {
      return await this.auth.verifyCode(req.user.userId, dto.code);
    } catch (e: any) {
      throw new BadRequestException(humanizeTgError(e, 'verify-code'));
    }
  }

  /** POST /api/snipe/tg/verify-2fa */
  @Post('verify-2fa')
  async verify2fa(@Req() req: any, @Body() dto: Verify2faDto) {
    try {
      return await this.auth.verify2fa(req.user.userId, dto.password);
    } catch (e: any) {
      throw new BadRequestException(humanizeTgError(e, 'verify-2fa'));
    }
  }

  /** DELETE /api/snipe/tg/session */
  @Delete('session')
  async disconnect(@Req() req: any) {
    await this.userbot.disconnect(req.user.userId);
    return { ok: true };
  }

  /** GET /api/snipe/tg/groups */
  @Get('groups')
  async groups(@Req() req: any) {
    try {
      return await this.userbot.getGroups(req.user.userId);
    } catch (e: any) {
      throw new BadRequestException(e.message ?? 'Not connected');
    }
  }

  /** GET /api/snipe/tg/groups/:groupId/messages — recent message history for a group */
  @Get('groups/:groupId/messages')
  async groupMessages(
    @Req() req: any,
    @Param('groupId') groupId: string,
    @Query('limit') limit?: string,
  ) {
    try {
      return await this.userbot.getGroupMessages(
        req.user.userId,
        groupId,
        Math.min(Number(limit ?? 50), 100),
      );
    } catch (e: any) {
      throw new BadRequestException(e.message ?? 'Failed to fetch messages');
    }
  }
}
