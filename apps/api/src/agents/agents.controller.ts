import { Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AgentsService } from './agents.service';

@UseGuards(JwtAuthGuard)
@Controller('agents')
export class AgentsController {
  constructor(private svc: AgentsService) {}
  @Get() list(@Req() req: any) { return this.svc.list(req.user.userId); }
  @Post(':id/pause') pause(@Req() req: any, @Param('id') id: string) { return this.svc.pause(req.user.userId, id); }
  @Post(':id/resume') resume(@Req() req: any, @Param('id') id: string) { return this.svc.resume(req.user.userId, id); }
  @Delete(':id') kill(@Req() req: any, @Param('id') id: string) { return this.svc.kill(req.user.userId, id); }
  @Delete() killAll(@Req() req: any) { return this.svc.killAll(req.user.userId); }
}
