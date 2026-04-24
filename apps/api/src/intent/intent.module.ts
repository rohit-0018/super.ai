import { forwardRef, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { AiAgentModule } from '../ai-agent/ai-agent.module';
import { IntentController } from './intent.controller';
import { IntentRuleService } from './intent-rule.service';
import { IntentRuleEnforcer } from './intent-rule.enforcer';
import { IntentExtractorService } from './intent-extractor.service';

@Module({
  imports: [PrismaModule, AuthModule, forwardRef(() => AiAgentModule)],
  controllers: [IntentController],
  providers: [IntentRuleService, IntentRuleEnforcer, IntentExtractorService],
  exports: [IntentRuleService, IntentRuleEnforcer, IntentExtractorService],
})
export class IntentModule {}
