import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { resolve } from 'path';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
import { LiveGuardModule } from './common/live-guard.module';
import { AuthModule } from './auth/auth.module';
import { WalletsModule } from './wallets/wallets.module';
import { MarketDataModule } from './market-data/market-data.module';
import { TokenIntelModule } from './token-intel/token-intel.module';
import { TokenAnalysisModule } from './token-analysis/token-analysis.module';
import { ProviderPoolModule } from './provider-pool/provider-pool.module';
import { WalletAnalysisModule } from './wallet-analysis/wallet-analysis.module';
import { AiAgentModule } from './ai-agent/ai-agent.module';
import { ExecutionModule } from './execution/execution.module';
import { GuardrailsModule } from './guardrails/guardrails.module';
import { PaperTradingModule } from './paper-trading/paper-trading.module';
import { AgentsModule } from './agents/agents.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { SocialModule } from './social/social.module';
import { CexModule } from './cex/cex.module';
import { WsModule } from './ws/ws.module';
import { UsersModule } from './users/users.module';
import { NewsModule } from './news/news.module';
import { SecurityModule } from './security/security.module';
import { TelegramModule } from './telegram/telegram.module';
import { StrategiesModule } from './strategies/strategies.module';
import { ApprovalsModule } from './approvals/approvals.module';
import { IntentModule } from './intent/intent.module';
import { ConversationsModule } from './conversations/conversations.module';
import { EpisodesModule } from './episodes/episodes.module';
import { SnipeModule } from './snipe/snipe.module';
import { HotTokensModule } from './hot-tokens/hot-tokens.module';
import { HealthController } from './health.controller';
import { TraceMiddleware } from './common/trace.middleware';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [
        resolve(process.cwd(), '.env'),
        resolve(process.cwd(), '../../.env'),
        resolve(__dirname, '../../../.env'),
      ],
    }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    SecurityModule,
    PrismaModule,
    LiveGuardModule,
    AuthModule,
    WalletsModule,
    MarketDataModule,
    TokenIntelModule,
    ProviderPoolModule,
    TokenAnalysisModule,
    WalletAnalysisModule,
    AiAgentModule,
    ExecutionModule,
    GuardrailsModule,
    PaperTradingModule,
    AgentsModule,
    AnalyticsModule,
    SocialModule,
    CexModule,
    WsModule,
    UsersModule,
    NewsModule,
    TelegramModule,
    StrategiesModule,
    ApprovalsModule,
    IntentModule,
    ConversationsModule,
    EpisodesModule,
    SnipeModule,
    HotTokensModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Must run before auth so any generated id is stamped on the response; auth
    // still runs downstream and populates req.user — but by that point the
    // traceStore scope is already live, so subsequent services see the traceId.
    consumer.apply(TraceMiddleware).forRoutes('*');
  }
}
