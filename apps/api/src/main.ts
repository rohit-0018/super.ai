import 'reflect-metadata';
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'path';
for (const p of [resolve(process.cwd(), '.env'), resolve(__dirname, '../../../.env')]) {
  loadDotenv({ path: p });
}
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { getNetworkMode } from './common/network-config';
import { EtagInterceptor } from './common/etag.interceptor';

// teleproto/gramjs holds long-lived MTProto TCP sockets to Telegram DCs. These
// get reset on idle by Render's NAT or Telegram's edge (NAT timeouts, DC
// failover). The library auto-reconnects fine, but it logs the raw socket
// error via console.error AND occasionally lets it bubble as uncaughtException
// — neither carries any app frames. Filter both channels to keep logs readable;
// every other error path propagates normally.
const isTeleprotoSocketReset = (err: any): boolean => {
  if (!err) return false;
  if (err.code === 'ECONNRESET') {
    const stack = String(err.stack ?? '');
    if (stack.includes('TCP.onStreamRead') && !stack.includes('apps/api')) return true;
  }
  return false;
};

// Patch console.error to drop teleproto ECONNRESET prints. NestJS Logger writes
// to stdout via its own formatter, so this only affects stray console.error
// calls — exactly what gramjs uses internally.
const originalConsoleError = console.error.bind(console);
console.error = (...args: any[]) => {
  for (const a of args) {
    if (isTeleprotoSocketReset(a)) return;
    if (typeof a === 'string' && /ECONNRESET/.test(a) && /TCP\.onStreamRead/.test(args.join('\n'))) return;
  }
  originalConsoleError(...args);
};

process.on('uncaughtException', (err: any) => {
  if (isTeleprotoSocketReset(err)) return;
  Logger.error(`uncaughtException: ${err?.message ?? err}`, err?.stack, 'Bootstrap');
});
process.on('unhandledRejection', (reason: any) => {
  if (isTeleprotoSocketReset(reason)) return;
  Logger.error(`unhandledRejection: ${reason?.message ?? reason}`, reason?.stack, 'Bootstrap');
});

async function bootstrap() {
  // Loud boot banner — misconfigured deploys (mainnet + local KMS fallback) should be obvious.
  const mode = getNetworkMode();
  const kms = process.env.AWS_KMS_KEY_ID ? 'AWS-KMS' : 'LOCAL-FALLBACK';
  Logger.log(`[QWAI] network=${mode.toUpperCase()}  kms=${kms}`, 'Bootstrap');

  const app = await NestFactory.create(AppModule, { cors: true });
  app.use(helmet());
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  // ETag/304 on every GET so the SPA's revalidation hops are cheap (~5-15ms).
  // Combined with the client's stale-while-revalidate cache (useApi), nav
  // transitions render instantly and only drop a payload on actual change.
  app.useGlobalInterceptors(new EtagInterceptor());

  // Critical: without this, OnModuleDestroy / OnApplicationShutdown hooks never run
  // on SIGINT/SIGTERM, so BullMQ workers keep the socket bound after Ctrl+C and
  // the next dev restart hits EADDRINUSE.
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 4400);
  await app.listen(port);
  Logger.log(`QWAI API listening on :${port}`, 'Bootstrap');

  // Belt-and-suspenders: force a clean exit if something keeps the event loop alive.
  const shutdown = async (signal: string) => {
    Logger.log(`Received ${signal}, closing…`, 'Bootstrap');
    try {
      await app.close();
    } catch (e) {
      Logger.error(`Error during shutdown: ${(e as Error).message}`, 'Bootstrap');
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
bootstrap();
