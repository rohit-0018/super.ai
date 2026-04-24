import { Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { IsEnum, IsInt, IsNumber, IsObject, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { IntentScope, IntentSource, IntentStatus } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { IntentRuleService } from './intent-rule.service';
import { IntentRuleDsl } from './intent-rule.dsl';

class CreateIntentRuleDto {
  @IsString() @MinLength(3) @MaxLength(400) text!: string;
  @IsObject() rule!: Record<string, unknown>;
  @IsEnum(IntentScope) scope!: IntentScope;
  @IsOptional() @IsInt() @Min(0) @Max(100) priority?: number;
}

class UpdateIntentRuleDto {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(400) text?: string;
  @IsOptional() @IsObject() rule?: Record<string, unknown>;
  @IsOptional() @IsEnum(IntentScope) scope?: IntentScope;
  @IsOptional() @IsInt() @Min(0) @Max(100) priority?: number;
}

@UseGuards(JwtAuthGuard)
@Controller('me/rules')
export class IntentController {
  constructor(private svc: IntentRuleService) {}

  @Get()
  async list(@Req() req: any) {
    const all = await this.svc.listAll(req.user.userId);
    return {
      active: all.filter((r) => r.status === IntentStatus.ACTIVE),
      proposed: all.filter((r) => r.status === IntentStatus.PROPOSED),
      conflicted: all.filter((r) => r.status === IntentStatus.CONFLICTED),
    };
  }

  @Post()
  create(@Req() req: any, @Body() dto: CreateIntentRuleDto) {
    return this.svc.propose(req.user.userId, {
      text: dto.text,
      rule: dto.rule as unknown as IntentRuleDsl,
      source: IntentSource.MANUAL,
      scope: dto.scope,
      confidence: 1.0,
      priority: dto.priority,
    });
  }

  @Patch(':id')
  async update(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateIntentRuleDto) {
    return this.svc.update(req.user.userId, id, {
      text: dto.text,
      rule: dto.rule as unknown as IntentRuleDsl | undefined,
      scope: dto.scope,
      priority: dto.priority,
    });
  }

  @Post(':id/accept')
  accept(@Req() req: any, @Param('id') id: string) {
    return this.svc.updateStatus(req.user.userId, id, IntentStatus.ACTIVE);
  }

  @Post(':id/reject')
  reject(@Req() req: any, @Param('id') id: string) {
    return this.svc.updateStatus(req.user.userId, id, IntentStatus.RETIRED, 'USER_REJECTED_PROPOSAL');
  }

  @Delete(':id')
  async remove(@Req() req: any, @Param('id') id: string) {
    await this.svc.updateStatus(req.user.userId, id, IntentStatus.RETIRED, 'USER_DELETED');
    return { ok: true };
  }
}
