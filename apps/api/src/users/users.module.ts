import { forwardRef, Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AiAgentModule } from '../ai-agent/ai-agent.module';

@Module({
  imports: [PrismaModule, forwardRef(() => AiAgentModule)],
  controllers: [UsersController],
})
export class UsersModule {}
