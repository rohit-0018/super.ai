import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { IsString, Length, Matches } from 'class-validator';
import { AuthService } from './auth.service';
import { TelegramLinkService } from './telegram-link.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { NonceDto, RefreshDto, VerifyDto } from './dto';

class TgLinkDto {
  @IsString() @Length(4, 16) code!: string;
  @IsString() telegramChatId!: string;
}

class PhoneRequestDto {
  @IsString() @Matches(/^\+?[0-9\s\-().]{7,20}$/) phone!: string;
}

class PhoneVerifyDto {
  @IsString() phone!: string;
  @IsString() @Length(6, 6) otp!: string;
}

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService, private tgLink: TelegramLinkService) {}

  @Post('nonce')
  async nonce(@Body() dto: NonceDto) {
    const nonce = await this.auth.issueNonce(dto.address, dto.chain);
    return { nonce, message: `QWAI Sign-In\nNonce: ${nonce}` };
  }

  @Post('verify')
  verify(@Body() dto: VerifyDto) {
    return this.auth.verifyAndIssueTokens(dto.address, dto.chain, dto.signature, dto.nonce);
  }

  @Post('refresh')
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Post('logout')
  async logout(@Body() dto: RefreshDto) {
    await this.auth.logout(dto.refreshToken);
    return { ok: true };
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@Req() req: any) {
    return this.auth.getUserById(req.user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('telegram/code')
  issueTelegramCode(@Req() req: any) {
    return this.tgLink.issueCode(req.user.userId);
  }

  @Post('telegram/link')
  linkTelegram(@Body() dto: TgLinkDto) {
    return this.tgLink.link(dto.telegramChatId, dto.code);
  }

  @Post('phone/request')
  async phoneRequest(@Body() dto: PhoneRequestDto) {
    await this.auth.requestPhoneOtp(dto.phone);
    return { ok: true };
  }

  @Post('phone/verify')
  phoneVerify(@Body() dto: PhoneVerifyDto) {
    return this.auth.verifyPhoneOtp(dto.phone, dto.otp);
  }
}
