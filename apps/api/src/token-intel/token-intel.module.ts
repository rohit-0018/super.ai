import { forwardRef, Module } from '@nestjs/common';
import { TokenIntelService } from './token-intel.service';
import { TokenIntelController } from './token-intel.controller';
import { GoPlusProvider } from './providers/goplus.provider';
import { RugCheckProvider } from './providers/rugcheck.provider';
import { ConvictionEngine } from './conviction.engine';
import { AgentsModule } from '../agents/agents.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule, forwardRef(() => AgentsModule)],
  providers: [TokenIntelService, GoPlusProvider, RugCheckProvider, ConvictionEngine],
  controllers: [TokenIntelController],
  exports: [TokenIntelService, ConvictionEngine],
})
export class TokenIntelModule {}
