import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { IntelSnapshotService } from './intel-snapshot.service';

@Module({
  imports: [PrismaModule],
  providers: [IntelSnapshotService],
  exports: [IntelSnapshotService],
})
export class IntelTrackModule {}
