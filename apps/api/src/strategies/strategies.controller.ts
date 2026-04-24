import { Body, Controller, Delete, Get, NotFoundException, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { IsBoolean, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { StrategySource } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { StrategyPerformanceService } from './strategy-performance.service';

class StrategyDefinitionDto {
  @IsOptional() @IsString() @MaxLength(4000) prompt?: string;
  @IsOptional() @IsObject() trigger?: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

class CreateStrategyDto {
  @IsString() @MinLength(1) @MaxLength(80) name!: string;
  @IsObject() definition!: StrategyDefinitionDto;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

class UpdateStrategyDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) name?: string;
  @IsOptional() @IsObject() definition?: StrategyDefinitionDto;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

@UseGuards(JwtAuthGuard)
@Controller('strategies')
export class StrategiesController {
  constructor(
    private prisma: PrismaService,
    private performance: StrategyPerformanceService,
  ) {}

  @Get()
  list(@Req() req: any) {
    return this.prisma.userStrategy.findMany({
      where: { userId: req.user.userId },
      include: { performance: true },
      orderBy: [{ enabled: 'desc' }, { score: 'desc' }, { createdAt: 'desc' }],
    });
  }

  @Get(':id/performance')
  async getPerformance(@Req() req: any, @Param('id') id: string) {
    const perf = await this.performance.getForUser(req.user.userId, id);
    if (!perf) throw new NotFoundException();
    return perf;
  }

  @Post()
  create(@Req() req: any, @Body() dto: CreateStrategyDto) {
    return this.prisma.userStrategy.create({
      data: {
        userId: req.user.userId,
        name: dto.name,
        source: StrategySource.USER_DEFINED,
        definition: (dto.definition ?? {}) as any,
        enabled: dto.enabled ?? false,
      },
    });
  }

  @Put(':id')
  async update(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateStrategyDto) {
    const existing = await this.prisma.userStrategy.findUnique({ where: { id } });
    if (!existing || existing.userId !== req.user.userId) throw new NotFoundException();
    return this.prisma.userStrategy.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.definition !== undefined ? { definition: dto.definition as any } : {}),
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
      },
    });
  }

  @Delete(':id')
  async remove(@Req() req: any, @Param('id') id: string) {
    const existing = await this.prisma.userStrategy.findUnique({ where: { id } });
    if (!existing || existing.userId !== req.user.userId) throw new NotFoundException();
    await this.prisma.userStrategy.delete({ where: { id } });
    return { ok: true };
  }
}
