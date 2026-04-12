import { z } from 'zod';
import { SecurityEventTypeSchema } from '../types/events.js';
import { CircuitBreakerSnapshotSchema } from '../types/risk.js';

// ─── Result Status Enum ─────────────────────────────────────────────────────

export enum ResultStatus {
  SUCCESS = 'SUCCESS',
  FAILURE = 'FAILURE',
  BLOCKED = 'BLOCKED',
  WARNING = 'WARNING',
}

export const ResultStatusSchema = z.nativeEnum(ResultStatus);

// ─── Log Entry Schema ───────────────────────────────────────────────────────

export const LogEntrySchema = z.object({
  id: z.string().uuid().describe('Unique identifier for this log entry'),
  correlationId: z.string().describe('Correlation ID linking related events'),
  timestamp: z.string().datetime().describe('ISO-8601 timestamp of the log entry'),
  userId: z.string().optional().describe('User ID associated with this event'),
  sessionId: z.string().optional().describe('Session ID associated with this event'),
  strategyId: z.string().optional().describe('Strategy ID associated with this event'),
  eventType: SecurityEventTypeSchema.describe('Type of security event'),
  actionName: z.string().optional().describe('Name of the action that triggered this event'),
  parameters: z.record(z.string(), z.unknown()).describe('Event parameters (PII-scrubbed)'),
  resultStatus: ResultStatusSchema.describe('Outcome status of the event'),
  latencyMs: z.number().describe('Processing latency in milliseconds'),
  circuitBreakerStates: z.array(CircuitBreakerSnapshotSchema).describe('Snapshot of circuit breaker states at event time'),
  systemPromptHash: z.string().describe('Hash of the system prompt at event time'),
  previousEntryHmac: z.string().describe('HMAC of the preceding log entry in the chain'),
  entryHmac: z.string().describe('HMAC of this log entry'),
});

// ─── Inferred Type ──────────────────────────────────────────────────────────

export type LogEntry = z.infer<typeof LogEntrySchema>;
