import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PaperTradingService } from './paper-trading.service';
import { IsBoolean } from 'class-validator';

class ToggleDto { @IsBoolean() enabled!: boolean; }

@UseGuards(JwtAuthGuard)
@Controller('paper')
export class PaperTradingController {
  constructor(private svc: PaperTradingService) {}
  @Post('switch') toggle(@Req() req: any, @Body() d: ToggleDto) { return this.svc.toggle(req.user.userId, d.enabled); }
  @Get('balance') balance(@Req() req: any) { return this.svc.balance(req.user.userId); }
  @Get('pnl') pnl(@Req() req: any) { return this.svc.pnl(req.user.userId).then((pnl) => ({ pnl })); }
}
