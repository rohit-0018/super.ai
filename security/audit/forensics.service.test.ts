import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForensicsService } from './forensics.service.js';
import { HmacChain } from './hmac.chain.js';
import { ResultStatus } from './log.entry.schema.js';
import type { LogEntry } from './log.entry.schema.js';
import { SecurityEventType, RiskLevel } from '../types/events.js';
import type { SecurityConfig } from '../types/config.js';
import { CircuitBreakerState } from '../types/risk.js';

// ─── Mock fs ────────────────────────────────────────────────────────────────

const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();

vi.mock('node:fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

const TEST_SECRET = 'a-very-secure-secret-that-is-at-least-32-chars-long!!';

function makeConfig(overrides: Partial<SecurityConfig> = {}): SecurityConfig {
  return {
    jwtPublicKeyPath: '/keys/public.pem',
    jwtPrivateKeyPath: '/keys/private.pem',
    accessTokenExpirySeconds: 900,
    refreshTokenExpirySeconds: 86400,
    mfaTotpIssuer: 'SuperAI',
    mfaStepUpThresholdRiskLevel: RiskLevel.HIGH,
    deviceTrustScoreThreshold: 70,
    deviceTrustScoreIncrement: 5,
    marketDataStalenessThresholdMs: 5000,
    feedConsensusDivergenceThresholdPercent: 1.5,
    feedSignaturePublicKeys: {},
    anomalyStdDevMultiplier: 3,
    anomalyWindowSize: 100,
    injectionDetectionThresholdScore: 0.7,
    piiScrubbingPatterns: [],
    approvedTradingUniverse: [],
    positionLimitsPerInstrument: {},
    portfolioNotionalLimit: 1_000_000,
    sessionDrawdownKillSwitchPercent: 10,
    velocityCircuitBreakerOrderCount: 50,
    velocityCircuitBreakerWindowSeconds: 60,
    errorRateCircuitBreakerConsecutiveRejectionCount: 5,
    tradingHoursPerMarket: { crypto: { open: '00:00', close: '23:59' } },
    highValueConfirmationThreshold: 50_000,
    washTradeDetectionWindowMs: 1000,
    layeringDetectionWindowMs: 5000,
    layeringCancelRatioThreshold: 0.8,
    rateLimitUser: { requests: 100, windowMs: 60_000 },
    rateLimitStrategy: { requests: 50, windowMs: 60_000 },
    rateLimitInstrument: { requests: 200, windowMs: 60_000 },
    rateLimitExchange: { requests: 1000, windowMs: 60_000 },
    redisUrl: 'redis://localhost:6379',
    kmsKeyArn: '',
    kmsProvider: 'local',
    secretsRotationPollIntervalSeconds: 300,
    deadManSwitchHeartbeatTimeoutSeconds: 120,
    auditLogOutputPath: './logs/audit.jsonl',
    hmacChainSecret: TEST_SECRET,
    corsAllowedOrigins: ['http://localhost:3000'],
    alertWebhookUrls: [],
    alertSlackChannel: '#security-alerts',
    encryptionKeyId: 'default-enc-key',
    signingPrivateKey: 'mock-private-key',
    signingPublicKey: 'mock-public-key',
    adminUserId: 'admin-1',
    environment: 'development',
    ...overrides,
  } as SecurityConfig;
}

function makeSignedEntry(
  chain: HmacChain,
  overrides: Partial<LogEntry> = {},
  previousHmac = '0'.repeat(64),
): LogEntry {
  const base: Omit<LogEntry, 'entryHmac'> = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    correlationId: 'corr-001',
    timestamp: '2026-04-12T10:00:00.000Z',
    userId: 'user-1',
    sessionId: 'session-1',
    strategyId: 'strategy-1',
    eventType: SecurityEventType.ACTION_ALLOWED,
    actionName: 'place_order',
    parameters: { instrument: 'BTC-USDT' },
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
    previousEntryHmac: previousHmac,
    ...overrides,
  };
  const hmac = chain.sign(base);
  return { ...base, entryHmac: hmac };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('ForensicsService', () => {
  let config: SecurityConfig;
  let hmacChain: HmacChain;
  let service: ForensicsService;

  beforeEach(() => {
    vi.clearAllMocks();
    config = makeConfig();
    hmacChain = new HmacChain(TEST_SECRET);
    service = new ForensicsService(config, hmacChain);
    mockWriteFile.mockResolvedValue(undefined);
  });

  describe('replay', () => {
    it('should return entries filtered by sessionId', async () => {
      const entry1 = makeSignedEntry(hmacChain, {
        id: '550e8400-e29b-41d4-a716-446655440001',
        sessionId: 'session-1',
      });
      const entry2 = makeSignedEntry(hmacChain, {
        id: '550e8400-e29b-41d4-a716-446655440002',
        sessionId: 'session-2',
      });
      const entry3 = makeSignedEntry(hmacChain, {
        id: '550e8400-e29b-41d4-a716-446655440003',
        sessionId: 'session-1',
        timestamp: '2026-04-12T10:01:00.000Z',
      });

      const jsonl = [entry1, entry2, entry3].map((e) => JSON.stringify(e)).join('\n');
      mockReadFile.mockResolvedValue(jsonl);

      const replay = await service.replay('session-1');

      expect(replay.sessionId).toBe('session-1');
      expect(replay.entries).toHaveLength(2);
      expect(replay.entries[0]!.id).toBe('550e8400-e29b-41d4-a716-446655440001');
      expect(replay.entries[1]!.id).toBe('550e8400-e29b-41d4-a716-446655440003');
    });

    it('should return entries sorted chronologically', async () => {
      const entry1 = makeSignedEntry(hmacChain, {
        id: '550e8400-e29b-41d4-a716-446655440001',
        sessionId: 'session-1',
        timestamp: '2026-04-12T10:05:00.000Z',
      });
      const entry2 = makeSignedEntry(hmacChain, {
        id: '550e8400-e29b-41d4-a716-446655440002',
        sessionId: 'session-1',
        timestamp: '2026-04-12T10:01:00.000Z',
      });

      const jsonl = [entry1, entry2].map((e) => JSON.stringify(e)).join('\n');
      mockReadFile.mockResolvedValue(jsonl);

      const replay = await service.replay('session-1');

      expect(replay.entries[0]!.timestamp).toBe('2026-04-12T10:01:00.000Z');
      expect(replay.entries[1]!.timestamp).toBe('2026-04-12T10:05:00.000Z');
    });

    it('should report chain as valid when all HMACs are correct', async () => {
      const entry = makeSignedEntry(hmacChain, {
        id: '550e8400-e29b-41d4-a716-446655440001',
        sessionId: 'session-1',
      });

      mockReadFile.mockResolvedValue(JSON.stringify(entry));

      const replay = await service.replay('session-1');
      expect(replay.chainValid).toBe(true);
    });

    it('should report chain as invalid when an HMAC is tampered', async () => {
      const entry = makeSignedEntry(hmacChain, {
        id: '550e8400-e29b-41d4-a716-446655440001',
        sessionId: 'session-1',
      });
      const tampered = { ...entry, latencyMs: 9999 };

      mockReadFile.mockResolvedValue(JSON.stringify(tampered));

      const replay = await service.replay('session-1');
      expect(replay.chainValid).toBe(false);
    });

    it('should handle empty results', async () => {
      mockReadFile.mockResolvedValue('');

      const replay = await service.replay('nonexistent');

      expect(replay.entries).toHaveLength(0);
      expect(replay.chainValid).toBe(true);
      expect(replay.summary.totalActions).toBe(0);
      expect(replay.summary.firstTimestamp).toBe('');
      expect(replay.summary.lastTimestamp).toBe('');
    });

    it('should build correct summary with counts per event type', async () => {
      const entry1 = makeSignedEntry(hmacChain, {
        id: '550e8400-e29b-41d4-a716-446655440001',
        sessionId: 'session-1',
        eventType: SecurityEventType.ACTION_ALLOWED,
        resultStatus: ResultStatus.SUCCESS,
      });
      const entry2 = makeSignedEntry(hmacChain, {
        id: '550e8400-e29b-41d4-a716-446655440002',
        sessionId: 'session-1',
        eventType: SecurityEventType.ACTION_BLOCKED,
        resultStatus: ResultStatus.BLOCKED,
        timestamp: '2026-04-12T10:01:00.000Z',
      });
      const entry3 = makeSignedEntry(hmacChain, {
        id: '550e8400-e29b-41d4-a716-446655440003',
        sessionId: 'session-1',
        eventType: SecurityEventType.ANOMALY_DETECTED,
        resultStatus: ResultStatus.WARNING,
        timestamp: '2026-04-12T10:02:00.000Z',
      });

      const jsonl = [entry1, entry2, entry3].map((e) => JSON.stringify(e)).join('\n');
      mockReadFile.mockResolvedValue(jsonl);

      const replay = await service.replay('session-1');

      expect(replay.summary.totalActions).toBe(3);
      expect(replay.summary.blockedActions).toBe(1);
      expect(replay.summary.anomaliesDetected).toBe(1);
      expect(replay.summary.countsPerEventType[SecurityEventType.ACTION_ALLOWED]).toBe(1);
      expect(replay.summary.countsPerEventType[SecurityEventType.ACTION_BLOCKED]).toBe(1);
      expect(replay.summary.countsPerEventType[SecurityEventType.ANOMALY_DETECTED]).toBe(1);
      expect(replay.summary.firstTimestamp).toBe('2026-04-12T10:00:00.000Z');
      expect(replay.summary.lastTimestamp).toBe('2026-04-12T10:02:00.000Z');
    });
  });

  describe('exportSession', () => {
    it('should write formatted JSON to the output path', async () => {
      const entry = makeSignedEntry(hmacChain, {
        id: '550e8400-e29b-41d4-a716-446655440001',
        sessionId: 'session-1',
      });
      mockReadFile.mockResolvedValue(JSON.stringify(entry));

      await service.exportSession('session-1', '/tmp/export.json');

      expect(mockWriteFile).toHaveBeenCalledTimes(1);
      const [path, content, encoding] = mockWriteFile.mock.calls[0] as [string, string, string];
      expect(path).toBe('/tmp/export.json');
      expect(encoding).toBe('utf-8');

      const parsed: unknown = JSON.parse(content);
      const replay = parsed as { sessionId: string; entries: unknown[]; chainValid: boolean };
      expect(replay.sessionId).toBe('session-1');
      expect(replay.entries).toHaveLength(1);
      expect(replay.chainValid).toBe(true);
    });

    it('should export empty session correctly', async () => {
      mockReadFile.mockResolvedValue('');

      await service.exportSession('nonexistent', '/tmp/empty.json');

      expect(mockWriteFile).toHaveBeenCalledTimes(1);
      const content = mockWriteFile.mock.calls[0]![1] as string;
      const parsed = JSON.parse(content) as { entries: unknown[] };
      expect(parsed.entries).toHaveLength(0);
    });
  });

  describe('file reading', () => {
    it('should read from the configured audit log path', async () => {
      mockReadFile.mockResolvedValue('');

      await service.replay('session-1');

      expect(mockReadFile).toHaveBeenCalledWith('./logs/audit.jsonl', 'utf-8');
    });

    it('should skip malformed JSONL lines', async () => {
      const validEntry = makeSignedEntry(hmacChain, {
        id: '550e8400-e29b-41d4-a716-446655440001',
        sessionId: 'session-1',
      });
      const jsonl = `not-valid-json\n${JSON.stringify(validEntry)}\n{"incomplete": true}`;
      mockReadFile.mockResolvedValue(jsonl);

      const replay = await service.replay('session-1');
      expect(replay.entries).toHaveLength(1);
    });
  });
});
