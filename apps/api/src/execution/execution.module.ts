import { Module } from '@nestjs/common';
import { ExecutionService } from './execution.service';
import { ExecutionController } from './execution.controller';
import { JupiterClient } from './jupiter.client';
import { OneInchClient } from './oneinch.client';
import { OrderManagerService } from './order-manager.service';
import { DcaService } from './dca.service';
import { WalletsModule } from '../wallets/wallets.module';
import { AiAgentModule } from '../ai-agent/ai-agent.module';

@Module({
  imports: [WalletsModule, AiAgentModule],
  providers: [ExecutionService, JupiterClient, OneInchClient, OrderManagerService, DcaService],
  controllers: [ExecutionController],
  exports: [ExecutionService, OrderManagerService, DcaService],
})
export class ExecutionModule {}
