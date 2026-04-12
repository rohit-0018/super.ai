import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import type { SecurityConfig } from '../types/config.js';
import type { SecurityEvent } from '../types/events.js';
import type { CircuitBreakerSnapshot } from '../types/risk.js';
import type { LogEntry } from './log.entry.schema.js';
import { ResultStatus } from './log.entry.schema.js';
import type { HmacChain } from './hmac.chain.js';

// ─── LogContext ─────────────────────────────────────────────────────────────

export interface LogContext {
  correlationId: string;
  userId?: string;
  sessionId?: string;
  strategyId?: string;
  latencyMs: number;
  circuitBreakerStates: ReadonlyArray<CircuitBreakerSnapshot>;
}

// ─── LogWriter Interface ────────────────────────────────────────────────────

export interface LogWriter {
  write(entry: LogEntry): Promise<void>;
}

// ─── JsonlFileWriter ────────────────────────────────────────────────────────

export class JsonlFileWriter implements LogWriter {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async write(entry: LogEntry): Promise<void> {
    const line = JSON.stringify(entry) + '\n';
    await appendFile(this.filePath, line, 'utf-8');
  }
}

// ─── NoopWriter ─────────────────────────────────────────────────────────────

export class NoopWriter implements LogWriter {
  async write(_entry: LogEntry): Promise<void> {
    // intentionally empty -- used in tests
  }
}

// ─── AuditLogger ────────────────────────────────────────────────────────────

export class AuditLogger {
  private readonly hmacChain: HmacChain;
  private readonly logWriter: LogWriter;
  private lastEntryHmac: string;

  constructor(_config: SecurityConfig, hmacChain: HmacChain, logWriter: LogWriter) {
    this.hmacChain = hmacChain;
    this.logWriter = logWriter;
    this.lastEntryHmac = '0'.repeat(64);
  }

  /**
   * Log a security event. NEVER THROWS -- errors are written to stderr.
   */
  async log(event: SecurityEvent, context: LogContext): Promise<void> {
    try {
      const entryWithoutHmac: Omit<LogEntry, 'entryHmac'> = {
        id: randomUUID(),
        correlationId: context.correlationId,
        timestamp: new Date().toISOString(),
        userId: context.userId,
        sessionId: context.sessionId,
        strategyId: context.strategyId,
        eventType: event.eventType,
        actionName: this.extractActionName(event),
        parameters: this.extractParameters(event),
        resultStatus: this.deriveResultStatus(event),
        latencyMs: context.latencyMs,
        circuitBreakerStates: [...context.circuitBreakerStates],
        systemPromptHash: this.computeSystemPromptHash(),
        previousEntryHmac: this.lastEntryHmac,
      };

      const entryHmac = this.hmacChain.sign(entryWithoutHmac);
      const entry: LogEntry = { ...entryWithoutHmac, entryHmac };

      await this.logWriter.write(entry);
      this.lastEntryHmac = entryHmac;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[AuditLogger] Failed to write audit log entry: ${message}\n`);
    }
  }

  /**
   * Generate a new correlation ID (UUID v4).
   */
  static getCorrelationId(): string {
    return randomUUID();
  }

  // ─── Private Helpers ────────────────────────────────────────────────────

  private extractActionName(event: SecurityEvent): string | undefined {
    const payload = event.payload as Record<string, unknown>;
    if ('actionType' in payload && typeof payload['actionType'] === 'string') {
      return payload['actionType'];
    }
    if ('triggerAction' in payload && typeof payload['triggerAction'] === 'string') {
      return payload['triggerAction'];
    }
    return undefined;
  }

  private extractParameters(event: SecurityEvent): Record<string, unknown> {
    // Return a shallow copy of the payload as already PII-scrubbed parameters
    const payload = event.payload as Record<string, unknown>;
    const params: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload)) {
      params[key] = value;
    }
    return params;
  }

  private deriveResultStatus(event: SecurityEvent): ResultStatus {
    const eventType = event.eventType;
    if (
      eventType.includes('FAILURE') ||
      eventType.includes('INVALID') ||
      eventType.includes('BREACHED') ||
      eventType === 'KILL_SWITCH_TRIGGERED' ||
      eventType === 'DEAD_MANS_SWITCH_TRIGGERED'
    ) {
      return ResultStatus.FAILURE;
    }
    if (
      eventType.includes('BLOCKED') ||
      eventType.includes('DENIED') ||
      eventType.includes('DETECTED') // wash trade, layering, injection, anomaly, duplicate
    ) {
      return ResultStatus.BLOCKED;
    }
    if (
      eventType.includes('WARNING') ||
      eventType.includes('STALE') ||
      eventType.includes('REQUIRED') ||
      eventType.includes('EXPIRED') ||
      eventType === 'CIRCUIT_BREAKER_HALF_OPEN'
    ) {
      return ResultStatus.WARNING;
    }
    return ResultStatus.SUCCESS;
  }

  private computeSystemPromptHash(): string {
    // Placeholder: in production this would hash the current system prompt
    return 'system-prompt-hash-placeholder';
  }
}
