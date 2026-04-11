import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { WalletsModule } from './wallets/wallets.module';
import { MarketDataModule } from './market-data/market-data.module';
import { TokenIntelModule } from './token-intel/token-intel.module';
import { AiAgentModule } from './ai-agent/ai-agent.module';
import { ExecutionModule } from './execution/execution.module';
import { GuardrailsModule } from './guardrails/guardrails.module';
import { PaperTradingModule } from './paper-trading/paper-trading.module';
import { AgentsModule } from './agents/agents.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { SocialModule } from './social/social.module';
import { CexModule } from './cex/cex.module';
import { WsModule } from './ws/ws.module';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    PrismaModule,
    AuthModule,
    WalletsModule,
    MarketDataModule,
    TokenIntelModule,
    AiAgentModule,
    ExecutionModule,
    GuardrailsModule,
    PaperTradingModule,
    AgentsModule,
    AnalyticsModule,
    SocialModule,
    CexModule,
    WsModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
