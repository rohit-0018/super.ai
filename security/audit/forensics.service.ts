import { readFile, writeFile } from 'node:fs/promises';
import type { SecurityConfig } from '../types/config.js';
import { LogEntrySchema } from './log.entry.schema.js';
import type { LogEntry } from './log.entry.schema.js';
import type { HmacChain, ChainVerificationResult } from './hmac.chain.js';

// ─── Session Replay Types ───────────────────────────────────────────────────

export interface SessionReplaySummary {
  countsPerEventType: Record<string, number>;
  firstTimestamp: string;
  lastTimestamp: string;
  totalActions: number;
  blockedActions: number;
  anomaliesDetected: number;
}

export interface SessionReplay {
  sessionId: string;
  entries: LogEntry[];
  chainValid: boolean;
  summary: SessionReplaySummary;
}

// ─── ForensicsService ───────────────────────────────────────────────────────

export class ForensicsService {
  private readonly config: SecurityConfig;
  private readonly hmacChain: HmacChain;

  constructor(config: SecurityConfig, hmacChain: HmacChain) {
    this.config = config;
    this.hmacChain = hmacChain;
  }

  /**
   * Replay a session by reading all log entries from the JSONL audit log
   * filtered by sessionId, ordered chronologically.
   */
  async replay(sessionId: string): Promise<SessionReplay> {
    const entries = await this.readEntriesForSession(sessionId);
    const chainResult = this.verifySessionChain(entries);
    const summary = this.buildSummary(entries);

    return {
      sessionId,
      entries,
      chainValid: chainResult.valid,
      summary,
    };
  }

  /**
   * Export a session replay as formatted JSON to the specified output path.
   */
  async exportSession(sessionId: string, outputPath: string): Promise<void> {
    const replay = await this.replay(sessionId);
    const formatted = JSON.stringify(replay, null, 2);
    await writeFile(outputPath, formatted, 'utf-8');
  }

  // ─── Private Helpers ────────────────────────────────────────────────────

  private async readEntriesForSession(sessionId: string): Promise<LogEntry[]> {
    const content = await readFile(this.config.auditLogOutputPath, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim().length > 0);
    const entries: LogEntry[] = [];

    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Skip malformed JSON lines
        continue;
      }
      const result = LogEntrySchema.safeParse(parsed);
      if (result.success && result.data.sessionId === sessionId) {
        entries.push(result.data);
      }
    }

    // Sort chronologically
    entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return entries;
  }

  private verifySessionChain(entries: ReadonlyArray<LogEntry>): ChainVerificationResult {
    if (entries.length === 0) {
      return { valid: true, totalEntries: 0 };
    }

    // Verify each entry's HMAC individually since session entries
    // may not be contiguous in the full chain
    for (let i = 0; i < entries.length; i++) {
      if (!this.hmacChain.verify(entries[i]!)) {
        return { valid: false, firstInvalidIndex: i, totalEntries: entries.length };
      }
    }

    return { valid: true, totalEntries: entries.length };
  }

  private buildSummary(entries: ReadonlyArray<LogEntry>): SessionReplaySummary {
    const countsPerEventType: Record<string, number> = {};
    let totalActions = 0;
    let blockedActions = 0;
    let anomaliesDetected = 0;

    for (const entry of entries) {
      const eventType = entry.eventType;
      countsPerEventType[eventType] = (countsPerEventType[eventType] ?? 0) + 1;
      totalActions++;

      if (entry.resultStatus === 'BLOCKED') {
        blockedActions++;
      }

      if (
        eventType === 'ANOMALY_DETECTED' ||
        eventType === 'FEED_ANOMALY_DETECTED' ||
        eventType === 'STRATEGY_DRIFT_DETECTED'
      ) {
        anomaliesDetected++;
      }
    }

    const firstTimestamp = entries.length > 0 ? entries[0]!.timestamp : '';
    const lastTimestamp = entries.length > 0 ? entries[entries.length - 1]!.timestamp : '';

    return {
      countsPerEventType,
      firstTimestamp,
      lastTimestamp,
      totalActions,
      blockedActions,
      anomaliesDetected,
    };
  }
}
