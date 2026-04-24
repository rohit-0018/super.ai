import { forwardRef, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { TokenIntelModule } from '../token-intel/token-intel.module';
import { EmbeddingService } from './embedding.service';
import { EpisodicMemoryService } from './episodic-memory.service';

@Module({
  imports: [PrismaModule, forwardRef(() => TokenIntelModule)],
  providers: [EmbeddingService, EpisodicMemoryService],
  exports: [EmbeddingService, EpisodicMemoryService],
})
export class EpisodesModule {}
