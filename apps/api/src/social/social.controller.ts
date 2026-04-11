import { Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SocialService } from './social.service';

@Controller('social')
export class SocialController {
  constructor(private svc: SocialService) {}

  @Get('leaderboard') leaderboard() { return this.svc.leaderboard(); }

  @UseGuards(JwtAuthGuard)
  @Post('copy/:wallet')
  copy(@Req() req: any, @Param('wallet') wallet: string) {
    return this.svc.startCopyTrade(req.user.userId, wallet);
  }
}
