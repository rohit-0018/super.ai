import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { TgAuthService } from './tg-auth.service';
import { TgUserbotService } from './tg-userbot.service';

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
  sendCode(@Req() req: any, @Body() dto: SendCodeDto) {
    return this.auth.sendCode(req.user.userId, dto.phoneNumber);
  }

  /** POST /api/snipe/tg/verify-code */
  @Post('verify-code')
  verifyCode(@Req() req: any, @Body() dto: VerifyCodeDto) {
    return this.auth.verifyCode(req.user.userId, dto.code);
  }

  /** POST /api/snipe/tg/verify-2fa */
  @Post('verify-2fa')
  verify2fa(@Req() req: any, @Body() dto: Verify2faDto) {
    return this.auth.verify2fa(req.user.userId, dto.password);
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
