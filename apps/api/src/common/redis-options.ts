import type { RedisOptions } from 'ioredis';

/**
 * Shared ioredis options. Centralized so every Redis client in the API has the
 * same resilience characteristics — Render's free-tier Redis closes idle
 * connections, and a naive client writes to the dead socket before its
 * reconnect logic notices, surfacing as `Error: write EPIPE`.
 *
 * Knobs:
 *  - `keepAlive: 30s`  — TCP keepalive probes prevent the idle-close in the first place.
 *  - `reconnectOnError` — when a write does sneak through to a dead socket, force a full
 *    reconnect instead of hanging on the broken pipe.
 *  - `retryStrategy`   — exponential backoff capped at 30s so we don't tight-loop.
 *  - `enableOfflineQueue: true` — commands issued during reconnect are buffered and replayed.
 *
 * `maxRetriesPerRequest` is the only knob callers usually need to override:
 *   - BullMQ requires `null` (queue/worker connections must wait through reconnects).
 *   - Cache-style clients can use a small number (e.g. 3) so a long outage fails fast
 *     and the caller falls back instead of stalling user requests.
 */
export function buildRedisOptions(overrides: Partial<RedisOptions> = {}): RedisOptions {
  return {
    keepAlive: 30_000,
    enableOfflineQueue: true,
    enableReadyCheck: true,
    maxRetriesPerRequest: 3,
    connectTimeout: 10_000,
    retryStrategy(times) {
      // 50ms, 100ms, 200ms, … capped at 30s.
      return Math.min(50 * 2 ** Math.min(times, 9), 30_000);
    },
    reconnectOnError(err) {
      const msg = err.message || '';
      // Codes that indicate the underlying socket is dead — force full reconnect.
      if (
        msg.includes('EPIPE') ||
        msg.includes('ECONNRESET') ||
        msg.includes('ETIMEDOUT') ||
        msg.startsWith('READONLY')
      ) {
        return true;
      }
      return false;
    },
    ...overrides,
  };
}
