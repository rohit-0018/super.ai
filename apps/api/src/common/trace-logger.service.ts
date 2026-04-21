import { Logger } from '@nestjs/common';
import { currentTraceId } from './trace-context';

type LogLevel = 'log' | 'warn' | 'error' | 'debug' | 'verbose';

/**
 * Emit a log line through a NestJS Logger, auto-prefixed with the current
 * traceId (if the call is happening inside a `traceStore.run(...)` scope).
 *
 * Example:
 *   logWithTrace(this.logger, 'log', `swap ok user=${u}`);
 *   // → "[trc=trc_abc123def456] swap ok user=u"
 */
export function logWithTrace(
  logger: Logger,
  level: LogLevel,
  msg: string,
  context?: string,
): void {
  const trace = currentTraceId();
  const prefixed = trace ? `[trc=${trace}] ${msg}` : msg;
  switch (level) {
    case 'warn':
      logger.warn(prefixed, context);
      break;
    case 'error':
      logger.error(prefixed, context);
      break;
    case 'debug':
      logger.debug(prefixed, context);
      break;
    case 'verbose':
      logger.verbose(prefixed, context);
      break;
    default:
      logger.log(prefixed, context);
  }
}

/**
 * Logger subclass that auto-prepends `[trc=<id>]` to every message when a
 * trace context is active. Drop-in replacement for `new Logger(name)`.
 */
export class TraceLogger extends Logger {
  private prefix(msg: unknown): string {
    const trace = currentTraceId();
    const str = typeof msg === 'string' ? msg : JSON.stringify(msg);
    return trace ? `[trc=${trace}] ${str}` : str;
  }

  log(message: unknown, ...optional: unknown[]): void {
    super.log(this.prefix(message), ...(optional as [])); // eslint-disable-line @typescript-eslint/no-explicit-any
  }
  warn(message: unknown, ...optional: unknown[]): void {
    super.warn(this.prefix(message), ...(optional as []));
  }
  error(message: unknown, ...optional: unknown[]): void {
    super.error(this.prefix(message), ...(optional as []));
  }
  debug(message: unknown, ...optional: unknown[]): void {
    super.debug(this.prefix(message), ...(optional as []));
  }
  verbose(message: unknown, ...optional: unknown[]): void {
    super.verbose(this.prefix(message), ...(optional as []));
  }
}
