import { Logger } from '@nestjs/common';

const logger = new Logger('Retry');

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; delayMs?: number; label?: string } = {},
): Promise<T> {
  const { attempts = 3, delayMs = 1000, label = 'operation' } = opts;
  let lastErr: Error | undefined;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      if (i < attempts) {
        logger.warn(`${label} attempt ${i}/${attempts} failed: ${err.message}. Retrying in ${delayMs}ms…`);
        await new Promise((r) => setTimeout(r, delayMs * i));
      }
    }
  }
  logger.error(`${label} failed after ${attempts} attempts: ${lastErr?.message}`);
  throw lastErr;
}
