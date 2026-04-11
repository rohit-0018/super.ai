import { BadRequestException, Body, Controller, Get, Headers, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { IsString } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { TelegramLinkService } from '../auth/telegram-link.service';
import { AiAgentService } from './ai-agent.service';
import { ConversationMemoryService } from './conversation-memory.service';

class ChatDto { @IsString() content!: string; }

@Controller('chat')
export class AiAgentController {
  constructor(
    private agent: AiAgentService,
    private memory: ConversationMemoryService,
    private tgLink: TelegramLinkService,
  ) {}

  @UseGuards(JwtAuthGuard)
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

  @Post('telegram')
  async chatTelegram(
    @Headers('x-telegram-id') chatId: string,
    @Body() dto: ChatDto,
  ): Promise<{ reply: string; linked: boolean }> {
    if (!chatId) throw new BadRequestException('Missing X-Telegram-Id');
    const userId = await this.tgLink.resolveByChatId(chatId);
    if (!userId) {
      return {
        linked: false,
        reply: 'This Telegram chat is not linked to a QWAI account. Open the web dashboard and run "Link Telegram" to get a code, then send /link <code> here.',
      };
    }
    const reply = await this.agent.chat(userId, dto.content, 'telegram');
    return { reply, linked: true };
  }

  @UseGuards(JwtAuthGuard)
  @Get('history')
  history(@Req() req: any) { return this.memory.recent(req.user.userId, 50); }
}
