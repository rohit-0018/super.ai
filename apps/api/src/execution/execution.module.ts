import { Module } from '@nestjs/common';
import { ExecutionService } from './execution.service';
import { ExecutionController } from './execution.controller';
import { JupiterClient } from './jupiter.client';
import { OneInchClient } from './oneinch.client';
import { OrderManagerService } from './order-manager.service';
import { DcaService } from './dca.service';
import { GasSchedulerService } from './gas-scheduler.service';
import { WalletsModule } from '../wallets/wallets.module';
import { AiAgentModule } from '../ai-agent/ai-agent.module';
import { GuardrailsModule } from '../guardrails/guardrails.module';
import { AgentsModule } from '../agents/agents.module';

@Module({
  imports: [WalletsModule, AiAgentModule, GuardrailsModule, AgentsModule],
  providers: [ExecutionService, JupiterClient, OneInchClient, OrderManagerService, DcaService, GasSchedulerService],
  controllers: [ExecutionController],
  exports: [ExecutionService, OrderManagerService, DcaService, GasSchedulerService],
})
export class ExecutionModule {}
