import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CexService } from './cex.service';
import { IsEnum, IsString } from 'class-validator';
import { Exchange } from '@prisma/client';

class ConnectDto {
  @IsEnum(Exchange) exchange!: Exchange;
  @IsString() apiKey!: string;
  @IsString() secret!: string;
}

@UseGuards(JwtAuthGuard)
@Controller('cex')
export class CexController {
  constructor(private svc: CexService) {}
  @Post() connect(@Req() req: any, @Body() dto: ConnectDto) {
    return this.svc.connect(req.user.userId, dto.exchange, dto.apiKey, dto.secret);
  }
  @Get('portfolio') portfolio(@Req() req: any) { return this.svc.unifiedPortfolio(req.user.userId); }
}
