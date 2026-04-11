import { Global, Module } from '@nestjs/common';
import { GuardrailsService } from './guardrails.service';
import { GuardrailsController } from './guardrails.controller';

@Global()
@Module({
  providers: [GuardrailsService],
  controllers: [GuardrailsController],
  exports: [GuardrailsService],
})
export class GuardrailsModule {}
