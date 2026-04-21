import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { newTraceId, traceStore } from './trace-context';

/**
 * Reads `X-Trace-Id` from the incoming request (or generates one), echoes it
 * back on the response, and wraps the remainder of the request inside a
 * `traceStore.run({ traceId, userId })` so downstream services can pick it up
 * via `currentTraceId()`.
 */
@Injectable()
export class TraceMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const headerVal = req.header('X-Trace-Id') ?? req.header('x-trace-id');
    const traceId: string =
      typeof headerVal === 'string' && headerVal.trim().length > 0
        ? headerVal.trim()
        : newTraceId();

    res.setHeader('X-Trace-Id', traceId);

    const userId: string | undefined = (req as any)?.user?.userId;
    traceStore.run({ traceId, userId }, () => next());
  }
}
