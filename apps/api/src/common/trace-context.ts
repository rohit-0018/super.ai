import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface TraceContext {
  traceId: string;
  userId?: string;
}

/**
 * AsyncLocalStorage-backed trace context. Every HTTP request entering the API
 * (via TraceMiddleware) runs inside `traceStore.run(...)`, so any downstream
 * service, worker callback, or notification can read the current traceId via
 * `currentTraceId()` without explicit plumbing.
 */
export const traceStore = new AsyncLocalStorage<TraceContext>();

/**
 * Generate a short, human-readable trace id.
 * Format: `trc_<12-chars-base36>` derived from a UUIDv4.
 */
export function newTraceId(): string {
  const uuid = randomUUID().replace(/-/g, '');
  // Convert the first 16 hex chars (64 bits) into base36 for compactness.
  const b36 = BigInt('0x' + uuid.slice(0, 16)).toString(36);
  return `trc_${b36.slice(0, 12).padStart(12, '0')}`;
}

export function withTrace<T>(
  fn: () => T | Promise<T>,
  opts: { traceId?: string; userId?: string } = {},
): T | Promise<T> {
  const ctx: TraceContext = {
    traceId: opts.traceId ?? newTraceId(),
    userId: opts.userId,
  };
  return traceStore.run(ctx, fn);
}

export function currentTraceId(): string | undefined {
  return traceStore.getStore()?.traceId;
}

export function currentUserId(): string | undefined {
  return traceStore.getStore()?.userId;
}
