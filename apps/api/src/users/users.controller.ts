import { Body, Controller, Get, Post, Put, Req, UseGuards } from '@nestjs/common';
import { IsArray, IsBoolean, IsEmail, IsEnum, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUrl, Max, Min } from 'class-validator';
import { AutonomyLevel, ApprovalChannel } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { ConvictionLearnerService } from '../ai-agent/conviction-learner.service';
import { DEFAULT_CONVICTION_WEIGHTS } from '../token-intel/conviction.engine';

class PaperModeDto {
  @IsBoolean() paperMode!: boolean;
}

class NotificationPrefsDto {
  @IsOptional() @IsBoolean() telegram?: boolean;
  @IsOptional() @IsString() email?: string | null;
  @IsOptional() @IsString() discordWebhook?: string | null;
}

class LearningConfigDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsEnum(AutonomyLevel) autonomyLevel?: AutonomyLevel;
  @IsOptional() @IsNumber() @Min(0) @Max(100_000) maxTradeUsd?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100) dailyLimit?: number;
  @IsOptional() @IsBoolean() approvalRequired?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(1440) approvalTimeoutMin?: number;
  @IsOptional() @IsArray() @IsEnum(ApprovalChannel, { each: true }) approvalChannels?: ApprovalChannel[];
  @IsOptional() @IsIn(['reject', 'execute']) onTimeout?: 'reject' | 'execute';
}

class ConvictionWeightsDto {
  @IsNumber() @Min(0) @Max(1) security!: number;
  @IsNumber() @Min(0) @Max(1) holders!: number;
  @IsNumber() @Min(0) @Max(1) liquidity!: number;
  @IsNumber() @Min(0) @Max(1) sentiment!: number;
  @IsNumber() @Min(0) @Max(1) momentum!: number;
  @IsOptional() @IsBoolean() manualOverride?: boolean;
}

@UseGuards(JwtAuthGuard)
@Controller('me')
export class UsersController {
  constructor(
    private prisma: PrismaService,
    private learner: ConvictionLearnerService,
  ) {}

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
        notificationPrefs: true,
        createdAt: true,
        learningConfig: true,
      },
    });
  }

  @Get('learning-config')
  async getLearningConfig(@Req() req: any) {
    // Upsert-on-read so the UI always has a row to edit, seeded with safe defaults.
    return this.prisma.learningConfig.upsert({
      where: { userId: req.user.userId },
      update: {},
      create: { userId: req.user.userId },
    });
  }

  @Put('learning-config')
  async setLearningConfig(@Req() req: any, @Body() dto: LearningConfigDto) {
    return this.prisma.learningConfig.upsert({
      where: { userId: req.user.userId },
      update: dto,
      create: { userId: req.user.userId, ...dto },
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

  @Get('dna')
  async dna(@Req() req: any) {
    return this.prisma.tradingDna.upsert({
      where: { userId: req.user.userId },
      update: {},
      create: { userId: req.user.userId },
    });
  }

  @Get('conviction-weights')
  async getConvictionWeights(@Req() req: any) {
    const row = await this.prisma.userConvictionWeights.findUnique({ where: { userId: req.user.userId } });
    if (row) return row;
    return {
      userId: req.user.userId,
      ...DEFAULT_CONVICTION_WEIGHTS,
      version: 0,
      sampleCount: 0,
      manualOverride: false,
      learnedAt: null,
      updatedAt: null,
    };
  }

  @Put('conviction-weights')
  async setConvictionWeights(@Req() req: any, @Body() dto: ConvictionWeightsDto) {
    const sum = dto.security + dto.holders + dto.liquidity + dto.sentiment + dto.momentum;
    if (sum <= 0.9 || sum >= 1.1) {
      // Auto-normalise rather than reject; UX has a 100% slider that can drift slightly.
    }
    const norm = sum > 0 ? {
      security: dto.security / sum,
      holders: dto.holders / sum,
      liquidity: dto.liquidity / sum,
      sentiment: dto.sentiment / sum,
      momentum: dto.momentum / sum,
    } : { ...DEFAULT_CONVICTION_WEIGHTS };
    const existing = await this.prisma.userConvictionWeights.findUnique({ where: { userId: req.user.userId } });
    const nextVersion = (existing?.version ?? 1) + 1;
    const row = await this.prisma.userConvictionWeights.upsert({
      where: { userId: req.user.userId },
      create: {
        userId: req.user.userId,
        ...norm,
        version: nextVersion,
        manualOverride: dto.manualOverride ?? true,
      },
      update: {
        ...norm,
        version: nextVersion,
        manualOverride: dto.manualOverride ?? true,
      },
    });
    await this.prisma.convictionWeightsHistory.create({
      data: { userId: req.user.userId, version: nextVersion, ...norm, sampleCount: existing?.sampleCount ?? 0, reason: 'manual' },
    });
    return row;
  }

  @Post('conviction-weights/reset')
  async resetConvictionWeights(@Req() req: any) {
    await this.learner.reset(req.user.userId);
    return this.prisma.userConvictionWeights.findUnique({ where: { userId: req.user.userId } });
  }
}
