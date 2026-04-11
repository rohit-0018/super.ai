import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { IsBoolean } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';

class PaperModeDto {
  @IsBoolean() paperMode!: boolean;
}

@UseGuards(JwtAuthGuard)
@Controller('me')
export class UsersController {
  constructor(private prisma: PrismaService) {}

  @Get()
  me(@Req() req: any) {
    return this.prisma.user.findUnique({
      where: { id: req.user.userId },
      select: {
        id: true,
        email: true,
        primaryWallet: true,
        telegramChatId: true,
        paperMode: true,
        createdAt: true,
      },
    });
  }

  @Post('paper-mode')
  setPaperMode(@Req() req: any, @Body() dto: PaperModeDto) {
    return this.prisma.user.update({
      where: { id: req.user.userId },
      data: { paperMode: dto.paperMode },
      select: { paperMode: true },
    });
  }
}
