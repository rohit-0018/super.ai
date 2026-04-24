// Seeds StrategyPerformance rows for every enabled strategy. Idempotent —
// safe to re-run. Until attribution lands on historic trades, most rows will
// be empty; the point is to have the table populated for read paths.
//
//   pnpm tsx scripts/backfill-strategy-performance.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../apps/api/src/app.module';
import { PrismaService } from '../apps/api/src/prisma/prisma.service';
import { StrategyPerformanceService } from '../apps/api/src/strategies/strategy-performance.service';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const prisma = app.get(PrismaService);
    const perf = app.get(StrategyPerformanceService);
    const strategies = await prisma.userStrategy.findMany({ select: { id: true, userId: true, name: true } });
    console.log(`Backfilling ${strategies.length} strategies…`);
    let ok = 0;
    let failed = 0;
    for (const s of strategies) {
      try {
        await perf.upsertFor(s.id, s.userId);
        ok++;
      } catch (e: any) {
        failed++;
        console.warn(`  ${s.id} (${s.name}) failed: ${e.message}`);
      }
    }
    console.log(`Done: ok=${ok} failed=${failed}`);
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
