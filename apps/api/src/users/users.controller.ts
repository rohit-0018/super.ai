import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { IsBoolean, IsEmail, IsOptional, IsString, IsUrl } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';

class PaperModeDto {
  @IsBoolean() paperMode!: boolean;
}

class NotificationPrefsDto {
  @IsOptional() @IsBoolean() telegram?: boolean;
  @IsOptional() @IsString() email?: string | null;
  @IsOptional() @IsString() discordWebhook?: string | null;
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

  @Post('notification-prefs')
  async setNotificationPrefs(@Req() req: any, @Body() dto: NotificationPrefsDto) {
    return this.prisma.$executeRawUnsafe(
      `UPDATE "User" SET "notificationPrefs" = $1::jsonb WHERE id = $2`,
      JSON.stringify(dto),
      req.user.userId,
    ).then(() => dto);
  }
}
