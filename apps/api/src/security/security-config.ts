import { ConfigService } from '@nestjs/config';

/**
 * Safe config accessor that falls back to process.env when ConfigService
 * is undefined (happens in worker process bootstrapped via tsx watch).
 */
export function safeGet<T = string>(config: ConfigService | undefined | null, key: string, fallback?: T): T {
  if (config) {
    try {
      const val = config.get<T>(key);
      return val ?? (fallback as T);
    } catch {
      // ConfigService not fully initialized
    }
  }
  const envVal = process.env[key];
  if (envVal !== undefined) return envVal as unknown as T;
  return fallback as T;
}
