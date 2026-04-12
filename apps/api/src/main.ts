import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: true });
  app.use(helmet());
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));

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
