import { Body, Controller, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { NonceDto, RefreshDto, VerifyDto } from './dto';

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

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
}
