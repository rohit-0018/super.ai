import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AiAgentService } from './ai-agent.service';
import { ConversationMemoryService } from './conversation-memory.service';
import { IsString } from 'class-validator';

class ChatDto { @IsString() content!: string; }

@UseGuards(JwtAuthGuard)
@Controller('chat')
export class AiAgentController {
  constructor(private agent: AiAgentService, private memory: ConversationMemoryService) {}

  @Post()
  async chat(@Req() req: any, @Body() dto: ChatDto, @Res() res: Response) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    try {
      for await (const chunk of this.agent.stream(req.user.userId, dto.content, 'web')) {
        res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
      }
      res.write('event: end\ndata: {}\n\n');
    } catch (e: any) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: e.message })}\n\n`);
    } finally {
      res.end();
    }
  }

  @Get('history')
  history(@Req() req: any) { return this.memory.recent(req.user.userId, 50); }
}
