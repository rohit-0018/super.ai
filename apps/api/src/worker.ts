import 'reflect-metadata';
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'path';
for (const p of [resolve(process.cwd(), '.env'), resolve(__dirname, '../../../.env')]) {
  loadDotenv({ path: p });
}
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { WorkerBootstrap } from './agents/worker.bootstrap';

async function main() {
  // Use AppModule so ConfigModule.forRoot(), SecurityModule, PrismaModule etc.
  // are all initialized before the worker tries to use them.
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
  const boot = app.get(WorkerBootstrap);
  await boot.start();
  Logger.log('QWAI background workers running', 'Worker');

  const shutdown = async (signal: string) => {
    Logger.log(`Worker received ${signal}, shutting down…`, 'Worker');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
main();
