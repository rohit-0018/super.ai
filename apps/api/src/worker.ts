import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AgentsModule } from './agents/agents.module';
import { WorkerBootstrap } from './agents/worker.bootstrap';

async function main() {
  const app = await NestFactory.createApplicationContext(AgentsModule);
  const boot = app.get(WorkerBootstrap);
  await boot.start();
  Logger.log('QWAI background workers running', 'Worker');
}
main();
