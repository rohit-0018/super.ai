import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { GuardrailsService } from './guardrails.service';

@UseGuards(JwtAuthGuard)
@Controller('guardrails')
export class GuardrailsController {
  constructor(private svc: GuardrailsService) {}
  @Get() get(@Req() req: any) { return this.svc.config(req.user.userId); }
  @Post() update(@Req() req: any, @Body() body: any) { return this.svc.update(req.user.userId, body); }
  @Post('kill') kill(@Req() req: any) { return this.svc.kill(req.user.userId); }
  @Post('simulate') simulate(@Req() req: any, @Body() body: { scenarioUsd: number }) {
    return this.svc.simulate(req.user.userId, body.scenarioUsd ?? 0);
  }
}
