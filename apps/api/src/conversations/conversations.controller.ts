import { Body, Controller, Delete, Get, NotFoundException, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsEnum, IsString, MaxLength, MinLength } from 'class-validator';
import { NoteCategory, NoteStatus } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ConversationService } from './conversation.service';
import { NoteService } from './note.service';

class CreateNoteDto {
  @IsEnum(NoteCategory) category!: NoteCategory;
  @IsString() @MinLength(3) @MaxLength(400) content!: string;
}

@UseGuards(JwtAuthGuard)
@Controller('me')
export class ConversationsController {
  constructor(private conversations: ConversationService, private notes: NoteService) {}

  @Get('conversations')
  async listConversations(@Req() req: any, @Query('limit') limit?: string) {
    const n = Math.max(1, Math.min(100, Number(limit ?? 30) || 30));
    return this.conversations.list(req.user.userId, n);
  }

  @Get('conversations/:id')
  async getConversation(@Req() req: any, @Param('id') id: string) {
    const c = await this.conversations.get(req.user.userId, id);
    if (!c) throw new NotFoundException();
    return c;
  }

  @Delete('conversations/:id')
  async deleteConversation(@Req() req: any, @Param('id') id: string) {
    const ok = await this.conversations.deleteConversation(req.user.userId, id);
    if (!ok) throw new NotFoundException();
    return { ok: true };
  }

  @Get('notes')
  listNotes(@Req() req: any, @Query('status') status?: NoteStatus, @Query('category') category?: NoteCategory) {
    return this.notes.list(req.user.userId, { status, category });
  }

  @Post('notes')
  createNote(@Req() req: any, @Body() dto: CreateNoteDto) {
    return this.notes.createManual(req.user.userId, dto);
  }

  @Delete('notes/:id')
  async deleteNote(@Req() req: any, @Param('id') id: string) {
    await this.notes.retire(req.user.userId, id, 'user-delete');
    return { ok: true };
  }
}
