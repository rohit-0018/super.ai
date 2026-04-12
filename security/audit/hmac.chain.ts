import { createHmac, timingSafeEqual } from 'node:crypto';
import type { LogEntry } from './log.entry.schema.js';

// ─── Chain Verification Result ──────────────────────────────────────────────

export interface ChainVerificationResult {
  valid: boolean;
  firstInvalidIndex?: number;
  totalEntries: number;
}

// ─── HmacChain ──────────────────────────────────────────────────────────────

export class HmacChain {
  private readonly secret: string;

  constructor(secret: string) {
    this.secret = secret;
  }

  /**
   * Compute canonical JSON from a log entry (excluding entryHmac),
   * then return the HMAC-SHA256 hex digest.
   */
  sign(entry: Omit<LogEntry, 'entryHmac'>): string {
    const canonical = this.canonicalize(entry);
    return createHmac('sha256', this.secret).update(canonical).digest('hex');
  }

  /**
   * Recompute the HMAC of a complete log entry and compare with the stored entryHmac.
   */
  verify(entry: LogEntry): boolean {
    const { entryHmac, ...rest } = entry;
    const computed = this.sign(rest);
    return this.safeCompare(computed, entryHmac);
  }

  /**
   * Verify an ordered chain of log entries.
   * Each entry's previousEntryHmac must equal the preceding entry's entryHmac.
   * Each entry's own HMAC must also be valid.
   */
  verifyChain(entries: ReadonlyArray<LogEntry>): ChainVerificationResult {
    if (entries.length === 0) {
      return { valid: true, totalEntries: 0 };
    }

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;

      // Verify the entry's own HMAC
      if (!this.verify(entry)) {
        return { valid: false, firstInvalidIndex: i, totalEntries: entries.length };
      }

      // For entries after the first, verify chain linkage
      if (i > 0) {
        const previousEntry = entries[i - 1]!;
        if (entry.previousEntryHmac !== previousEntry.entryHmac) {
          return { valid: false, firstInvalidIndex: i, totalEntries: entries.length };
        }
      }
    }

    return { valid: true, totalEntries: entries.length };
  }

  // ─── Private Helpers ────────────────────────────────────────────────────

  private canonicalize(entry: Omit<LogEntry, 'entryHmac'>): string {
    // Sort keys deterministically for canonical JSON
    return JSON.stringify(entry, Object.keys(entry).sort());
  }

  private safeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) {
      return false;
    }
    const bufA = Buffer.from(a, 'utf-8');
    const bufB = Buffer.from(b, 'utf-8');
    return timingSafeEqual(bufA, bufB);
  }
}
