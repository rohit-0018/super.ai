import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { IntelSnapshotService } from './intel-snapshot.service';
import { IntelRescanWorker } from './intel-rescan.worker';
import { IntelTrackController } from './intel-track.controller';

@Module({
  imports: [PrismaModule],
  providers: [IntelSnapshotService, IntelRescanWorker],
  controllers: [IntelTrackController],
  exports: [IntelSnapshotService],
})
export class IntelTrackModule {}
