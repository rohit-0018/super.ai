import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsNumber, IsOptional, IsString } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SocialService } from './social.service';

class RoomDto { @IsString() name!: string; }
class PostDto { @IsString() text!: string; }
class SignalDto {
  @IsString() token!: string;
  @IsString() chain!: string;
  @IsString() direction!: 'long' | 'short';
  @IsNumber() conviction!: number;
  @IsOptional() @IsString() note?: string;
}
class ReferralDto { @IsString() code!: string; }

@Controller('social')
export class SocialController {
  constructor(private svc: SocialService) {}

  @Get('leaderboard') leaderboard() { return this.svc.leaderboard(); }

  @UseGuards(JwtAuthGuard)
  @Post('copy/:wallet')
  copy(@Req() req: any, @Param('wallet') wallet: string) {
    return this.svc.startCopyTrade(req.user.userId, wallet);
  }

  @Get('rooms') listRooms() { return this.svc.listRooms(); }

  @UseGuards(JwtAuthGuard)
  @Post('rooms')
  createRoom(@Req() req: any, @Body() dto: RoomDto) { return this.svc.createRoom(req.user.userId, dto.name); }

  @Get('rooms/:id/messages')
  roomMessages(@Param('id') id: string) { return this.svc.getRoomMessages(id); }

  @UseGuards(JwtAuthGuard)
  @Post('rooms/:id/messages')
  postToRoom(@Req() req: any, @Param('id') id: string, @Body() dto: PostDto) {
    return this.svc.postToRoom(id, req.user.userId, dto.text);
  }

  @Get('signals') signalFeed(@Query('limit') limit?: string) { return this.svc.signalFeed(Number(limit) || 20); }

  @UseGuards(JwtAuthGuard)
  @Post('signals')
  createSignal(@Req() req: any, @Body() dto: SignalDto) { return this.svc.createSignalCard(req.user.userId, dto); }

  @UseGuards(JwtAuthGuard)
  @Post('referral/generate')
  generateReferral(@Req() req: any) { return this.svc.generateReferralCode(req.user.userId).then((code) => ({ code })); }

  @UseGuards(JwtAuthGuard)
  @Post('referral/claim')
  claimReferral(@Req() req: any, @Body() dto: ReferralDto) { return this.svc.claimReferral(req.user.userId, dto.code); }
}
