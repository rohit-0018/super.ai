import { describe, it, expect } from 'vitest';
import { HmacChain } from './hmac.chain.js';
import { ResultStatus } from './log.entry.schema.js';
import type { LogEntry } from './log.entry.schema.js';
import { SecurityEventType } from '../types/events.js';
import { CircuitBreakerState } from '../types/risk.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const TEST_SECRET = 'a-very-secure-secret-that-is-at-least-32-chars-long!!';

function makeEntry(overrides: Partial<LogEntry> = {}): Omit<LogEntry, 'entryHmac'> {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    correlationId: 'corr-001',
    timestamp: '2026-04-12T10:00:00.000Z',
    userId: 'user-1',
    sessionId: 'session-1',
    strategyId: 'strategy-1',
    eventType: SecurityEventType.ACTION_ALLOWED,
    actionName: 'place_order',
    parameters: { instrument: 'BTC-USDT', side: 'BUY' },
    resultStatus: ResultStatus.SUCCESS,
    latencyMs: 42,
    circuitBreakerStates: [
      {
        name: 'velocity',
        state: CircuitBreakerState.CLOSED,
        threshold: 50,
        currentCount: 3,
        lastStateChange: '2026-04-12T09:00:00.000Z',
      },
    ],
    systemPromptHash: 'abc123hash',
    previousEntryHmac: '0000000000000000000000000000000000000000000000000000000000000000',
    ...overrides,
  };
}

function makeSignedEntry(
  chain: HmacChain,
  overrides: Partial<LogEntry> = {},
  previousHmac = '0000000000000000000000000000000000000000000000000000000000000000',
): LogEntry {
  const partial = makeEntry({ previousEntryHmac: previousHmac, ...overrides });
  const hmac = chain.sign(partial);
  return { ...partial, entryHmac: hmac };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('HmacChain', () => {
  const chain = new HmacChain(TEST_SECRET);

  describe('sign', () => {
    it('should produce a deterministic hex HMAC', () => {
      const entry = makeEntry();
      const hmac1 = chain.sign(entry);
      const hmac2 = chain.sign(entry);
      expect(hmac1).toBe(hmac2);
      expect(hmac1).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should produce different HMACs for different entries', () => {
      const entry1 = makeEntry({ latencyMs: 10 });
      const entry2 = makeEntry({ latencyMs: 20 });
      expect(chain.sign(entry1)).not.toBe(chain.sign(entry2));
    });
  });

  describe('verify', () => {
    it('should return true for a correctly signed entry', () => {
      const signed = makeSignedEntry(chain);
      expect(chain.verify(signed)).toBe(true);
    });

    it('should return false for a tampered entry', () => {
      const signed = makeSignedEntry(chain);
      const tampered: LogEntry = { ...signed, latencyMs: 9999 };
      expect(chain.verify(tampered)).toBe(false);
    });

    it('should return false for a corrupted HMAC', () => {
      const signed = makeSignedEntry(chain);
      const corrupted: LogEntry = { ...signed, entryHmac: 'ff'.repeat(32) };
      expect(chain.verify(corrupted)).toBe(false);
    });
  });

  describe('verifyChain', () => {
    it('should return valid for an empty chain', () => {
      const result = chain.verifyChain([]);
      expect(result).toEqual({ valid: true, totalEntries: 0 });
    });

    it('should return valid for a single correctly signed entry', () => {
      const entry = makeSignedEntry(chain);
      const result = chain.verifyChain([entry]);
      expect(result).toEqual({ valid: true, totalEntries: 1 });
    });

    it('should return valid for a correctly linked chain', () => {
      const entry1 = makeSignedEntry(chain, { id: '550e8400-e29b-41d4-a716-446655440001' });
      const entry2 = makeSignedEntry(
        chain,
        { id: '550e8400-e29b-41d4-a716-446655440002', timestamp: '2026-04-12T10:01:00.000Z' },
        entry1.entryHmac,
      );
      const entry3 = makeSignedEntry(
        chain,
        { id: '550e8400-e29b-41d4-a716-446655440003', timestamp: '2026-04-12T10:02:00.000Z' },
        entry2.entryHmac,
      );

      const result = chain.verifyChain([entry1, entry2, entry3]);
      expect(result).toEqual({ valid: true, totalEntries: 3 });
    });

    it('should detect a broken chain linkage', () => {
      const entry1 = makeSignedEntry(chain, { id: '550e8400-e29b-41d4-a716-446655440001' });
      const entry2 = makeSignedEntry(
        chain,
        { id: '550e8400-e29b-41d4-a716-446655440002', timestamp: '2026-04-12T10:01:00.000Z' },
        entry1.entryHmac,
      );
      // entry3 links to entry1 instead of entry2 -- broken chain
      const entry3 = makeSignedEntry(
        chain,
        { id: '550e8400-e29b-41d4-a716-446655440003', timestamp: '2026-04-12T10:02:00.000Z' },
        entry1.entryHmac,
      );

      const result = chain.verifyChain([entry1, entry2, entry3]);
      expect(result).toEqual({ valid: false, firstInvalidIndex: 2, totalEntries: 3 });
    });

    it('should detect a tampered entry mid-chain', () => {
      const entry1 = makeSignedEntry(chain, { id: '550e8400-e29b-41d4-a716-446655440001' });
      const entry2 = makeSignedEntry(
        chain,
        { id: '550e8400-e29b-41d4-a716-446655440002', timestamp: '2026-04-12T10:01:00.000Z' },
        entry1.entryHmac,
      );

      // Tamper with entry2 after signing
      const tampered: LogEntry = { ...entry2, latencyMs: 9999 };

      const result = chain.verifyChain([entry1, tampered]);
      expect(result).toEqual({ valid: false, firstInvalidIndex: 1, totalEntries: 2 });
    });
  });
});
