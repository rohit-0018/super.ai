import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { IsBoolean, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApprovalChannel, RejectCategory } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ApprovalsService } from './approvals.service';

class RespondDto {
  @IsBoolean() accept!: boolean;
  @IsOptional() @IsEnum(RejectCategory) rejectCategory?: RejectCategory;
  @IsOptional() @IsString() @MaxLength(500) rejectReason?: string;
}

@UseGuards(JwtAuthGuard)
@Controller('approvals')
export class ApprovalsController {
  constructor(private svc: ApprovalsService) {}

  @Get('pending')
  pending(@Req() req: any) {
    return this.svc.listPending(req.user.userId);
  }

  @Post(':id/respond')
  respond(@Req() req: any, @Param('id') id: string, @Body() dto: RespondDto) {
    return this.svc.respond(req.user.userId, id, dto.accept, ApprovalChannel.WEB, {
      rejectCategory: dto.rejectCategory,
      rejectReason: dto.rejectReason,
    });
  }
}
