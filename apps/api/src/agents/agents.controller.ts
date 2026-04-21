import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AgentsService } from './agents.service';
import { AgentKind } from '@prisma/client';

@UseGuards(JwtAuthGuard)
@Controller('agents')
export class AgentsController {
  constructor(private svc: AgentsService) {}
  @Get() list(@Req() req: any) { return this.svc.list(req.user.userId); }

  @Post()
  create(@Req() req: any, @Body() body: { kind: AgentKind; params: Record<string, any> }) {
    return this.svc.create({ userId: req.user.userId, kind: body.kind, params: body.params });
  }

  @Post(':id/pause') pause(@Req() req: any, @Param('id') id: string) { return this.svc.pause(req.user.userId, id); }
  @Post(':id/resume') resume(@Req() req: any, @Param('id') id: string) { return this.svc.resume(req.user.userId, id); }
  @Delete(':id') kill(@Req() req: any, @Param('id') id: string) { return this.svc.kill(req.user.userId, id); }
  @Delete() killAll(@Req() req: any) { return this.svc.killAll(req.user.userId); }
}
