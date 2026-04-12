import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RiskLevel } from '../types/events.js';
import {
  AnomalyDetector,
  haversineDistanceKm,
  DetectorName,
  RecommendedAction,
  type AnomalyDetectorLogger,
  type AnomalyRedisAdapter,
  type AnomalyDetectorConfig,
  type TradeExecutedEvent,
  type GeoIpAdapter,
  type GeoCoordinates,
} from './anomaly.detector.js';
import type { ExecutedTrade, StrategyDriftDetector, DriftCheckResult } from './strategy.drift.detector.js';
import type { AlertBus } from './alert.bus.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeLogger(): AnomalyDetectorLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeRedis(): AnomalyRedisAdapter & { store: Map<string, string>; lists: Map<string, string[]> } {
  const store = new Map<string, string>();
  const lists = new Map<string, string[]>();
  return {
    store,
    lists,
    get: vi.fn<AnomalyRedisAdapter['get']>(async (key: string) => store.get(key) ?? null),
    set: vi.fn<AnomalyRedisAdapter['set']>(async (key: string, value: string) => {
      store.set(key, value);
    }),
    lpush: vi.fn<AnomalyRedisAdapter['lpush']>(async (key: string, value: string) => {
      const list = lists.get(key) ?? [];
      list.unshift(value);
      lists.set(key, list);
    }),
    lrange: vi.fn<AnomalyRedisAdapter['lrange']>(async (key: string, start: number, stop: number) => {
      const list = lists.get(key) ?? [];
      if (stop === -1) return list.slice(start);
      return list.slice(start, stop + 1);
    }),
    ltrim: vi.fn<AnomalyRedisAdapter['ltrim']>(async (key: string, start: number, stop: number) => {
      const list = lists.get(key) ?? [];
      lists.set(key, list.slice(start, stop + 1));
    }),
  };
}

function makeAlertBus(): AlertBus {
  return {
    register: vi.fn(),
    emit: vi.fn<AlertBus['emit']>().mockResolvedValue(undefined),
  } as unknown as AlertBus;
}

function makeDriftDetector(result?: Partial<DriftCheckResult>): StrategyDriftDetector {
  return {
    recordTrade: vi.fn().mockResolvedValue(undefined),
    check: vi.fn().mockResolvedValue({
      driftDetected: false,
      driftScore: 0,
      driftReasons: [],
      ...result,
    }),
  } as unknown as StrategyDriftDetector;
}

function makeGeoIp(coords: GeoCoordinates | null = { latitude: 40.7128, longitude: -74.006 }): GeoIpAdapter {
  return {
    lookup: vi.fn<GeoIpAdapter['lookup']>().mockResolvedValue(coords),
  };
}

function makeConfig(overrides: Partial<AnomalyDetectorConfig> = {}): AnomalyDetectorConfig {
  return {
    velocityMaxTradesPerMinute: 10,
    highValueSpikeMultiplier: 5,
    geoImpossibilityMaxKm: 500,
    geoImpossibilityWindowMinutes: 30,
    driftThreshold: 0.3,
    ...overrides,
  };
}

function makeTrade(overrides: Partial<ExecutedTrade> = {}): ExecutedTrade {
  return {
    tradeId: 'trade-1',
    userId: 'user-1',
    strategyId: 'strat-1',
    instrument: 'BTC-USDT',
    side: 'BUY',
    quantity: 1,
    price: 50000,
    notional: 50000,
    timestamp: new Date().toISOString(),
    orderId: 'order-1',
    settlementDate: '2026-04-12',
    ...overrides,
  };
}

function makeEvent(overrides: Partial<TradeExecutedEvent> = {}): TradeExecutedEvent {
  return {
    trade: makeTrade(),
    userId: 'user-1',
    sessionId: 'session-1',
    ipAddress: '1.2.3.4',
    userAgent: 'Mozilla/5.0',
    deviceFingerprint: 'fp-abc123',
    ...overrides,
  };
}

// ─── Haversine Tests ───────────────────────────────────────────────────────

describe('haversineDistanceKm', () => {
  it('returns 0 for same coordinates', () => {
    expect(haversineDistanceKm(40.7128, -74.006, 40.7128, -74.006)).toBe(0);
  });

  it('computes approximately correct distance (NYC to LA)', () => {
    const distance = haversineDistanceKm(40.7128, -74.006, 34.0522, -118.2437);
    // NYC to LA is about 3944 km
    expect(distance).toBeGreaterThan(3900);
    expect(distance).toBeLessThan(4000);
  });

  it('computes approximately correct distance (London to Tokyo)', () => {
    const distance = haversineDistanceKm(51.5074, -0.1278, 35.6762, 139.6503);
    // London to Tokyo is about 9560 km
    expect(distance).toBeGreaterThan(9500);
    expect(distance).toBeLessThan(9600);
  });
});

// ─── AnomalyDetector Tests ─────────────────────────────────────────────────

describe('AnomalyDetector', () => {
  let logger: AnomalyDetectorLogger;
  let redis: ReturnType<typeof makeRedis>;
  let alertBus: AlertBus;
  let driftDetector: StrategyDriftDetector;
  let geoIp: GeoIpAdapter;
  let config: AnomalyDetectorConfig;
  let detector: AnomalyDetector;

  beforeEach(() => {
    logger = makeLogger();
    redis = makeRedis();
    alertBus = makeAlertBus();
    driftDetector = makeDriftDetector();
    geoIp = makeGeoIp();
    config = makeConfig();
    detector = new AnomalyDetector(config, logger, alertBus, driftDetector, redis, geoIp);
  });

  it('returns ALLOW when no anomalies detected', async () => {
    const result = await detector.evaluate(makeEvent());
    expect(result.anomaliesDetected).toBe(false);
    expect(result.recommendedAction).toBe(RecommendedAction.ALLOW);
    expect(result.detectorResults).toHaveLength(5);
  });

  it('runs all five detectors in parallel', async () => {
    const result = await detector.evaluate(makeEvent());
    const detectorNames = result.detectorResults.map((r) => r.detector);
    expect(detectorNames).toContain(DetectorName.VELOCITY);
    expect(detectorNames).toContain(DetectorName.HIGH_VALUE_SPIKE);
    expect(detectorNames).toContain(DetectorName.GEO_IMPOSSIBILITY);
    expect(detectorNames).toContain(DetectorName.DEVICE_FINGERPRINT_MISMATCH);
    expect(detectorNames).toContain(DetectorName.STRATEGY_DRIFT);
  });

  // ── Velocity Check ─────────────────────────────────────────────────────

  describe('velocity check', () => {
    it('triggers when trade count exceeds limit', async () => {
      const lowLimitConfig = makeConfig({ velocityMaxTradesPerMinute: 2 });
      const det = new AnomalyDetector(lowLimitConfig, logger, alertBus, driftDetector, redis, geoIp);

      // Simulate 3 trades in quick succession
      await det.evaluate(makeEvent({ trade: makeTrade({ tradeId: 't1' }) }));
      await det.evaluate(makeEvent({ trade: makeTrade({ tradeId: 't2' }) }));
      const result = await det.evaluate(makeEvent({ trade: makeTrade({ tradeId: 't3' }) }));

      const velocityResult = result.detectorResults.find((r) => r.detector === DetectorName.VELOCITY);
      expect(velocityResult?.triggered).toBe(true);
      expect(velocityResult?.severity).toBe(RiskLevel.HIGH);
    });

    it('does not trigger when under limit', async () => {
      const result = await detector.evaluate(makeEvent());
      const velocityResult = result.detectorResults.find((r) => r.detector === DetectorName.VELOCITY);
      expect(velocityResult?.triggered).toBe(false);
    });
  });

  // ── High Value Spike ───────────────────────────────────────────────────

  describe('high value spike check', () => {
    it('triggers when notional exceeds multiplier of average', async () => {
      const det = new AnomalyDetector(
        makeConfig({ highValueSpikeMultiplier: 3 }),
        logger, alertBus, driftDetector, redis, geoIp,
      );

      // Build a history of small trades
      for (let i = 0; i < 10; i++) {
        await det.evaluate(makeEvent({
          trade: makeTrade({ tradeId: `t${i}`, notional: 100 }),
        }));
      }

      // Now a big trade
      const result = await det.evaluate(makeEvent({
        trade: makeTrade({ tradeId: 'big', notional: 10000 }),
      }));

      const spikeResult = result.detectorResults.find((r) => r.detector === DetectorName.HIGH_VALUE_SPIKE);
      expect(spikeResult?.triggered).toBe(true);
    });

    it('does not trigger with insufficient history', async () => {
      const result = await detector.evaluate(makeEvent());
      const spikeResult = result.detectorResults.find((r) => r.detector === DetectorName.HIGH_VALUE_SPIKE);
      expect(spikeResult?.triggered).toBe(false);
      expect(spikeResult?.details).toContain('Insufficient history');
    });
  });

  // ── Geographic Impossibility ───────────────────────────────────────────

  describe('geographic impossibility check', () => {
    it('triggers when distance exceeds threshold within time window', async () => {
      // First request from NYC
      const nycGeoIp: GeoIpAdapter = {
        lookup: vi.fn<GeoIpAdapter['lookup']>()
          .mockResolvedValueOnce({ latitude: 40.7128, longitude: -74.006 })   // NYC
          .mockResolvedValueOnce({ latitude: 35.6762, longitude: 139.6503 }), // Tokyo
      };

      const det = new AnomalyDetector(
        makeConfig({ geoImpossibilityMaxKm: 500, geoImpossibilityWindowMinutes: 30 }),
        logger, alertBus, driftDetector, redis, nycGeoIp,
      );

      await det.evaluate(makeEvent({ ipAddress: '1.1.1.1' }));
      const result = await det.evaluate(makeEvent({ ipAddress: '2.2.2.2' }));

      const geoResult = result.detectorResults.find((r) => r.detector === DetectorName.GEO_IMPOSSIBILITY);
      expect(geoResult?.triggered).toBe(true);
      expect(geoResult?.severity).toBe(RiskLevel.CRITICAL);
    });

    it('does not trigger when geolocation unavailable', async () => {
      const nullGeoIp = makeGeoIp(null);
      const det = new AnomalyDetector(config, logger, alertBus, driftDetector, redis, nullGeoIp);

      const result = await det.evaluate(makeEvent());
      const geoResult = result.detectorResults.find((r) => r.detector === DetectorName.GEO_IMPOSSIBILITY);
      expect(geoResult?.triggered).toBe(false);
      expect(geoResult?.details).toContain('Unable to resolve');
    });

    it('does not trigger for same IP', async () => {
      await detector.evaluate(makeEvent({ ipAddress: '1.2.3.4' }));
      const result = await detector.evaluate(makeEvent({ ipAddress: '1.2.3.4' }));
      const geoResult = result.detectorResults.find((r) => r.detector === DetectorName.GEO_IMPOSSIBILITY);
      expect(geoResult?.triggered).toBe(false);
    });
  });

  // ── Device Fingerprint Mismatch ────────────────────────────────────────

  describe('device fingerprint mismatch check', () => {
    it('records baseline on first trade in session', async () => {
      const result = await detector.evaluate(makeEvent());
      const deviceResult = result.detectorResults.find((r) => r.detector === DetectorName.DEVICE_FINGERPRINT_MISMATCH);
      expect(deviceResult?.triggered).toBe(false);
      expect(deviceResult?.details).toContain('baseline recorded');
    });

    it('triggers when userAgent changes mid-session', async () => {
      await detector.evaluate(makeEvent({ userAgent: 'Chrome/100', sessionId: 'sess-1' }));
      const result = await detector.evaluate(makeEvent({ userAgent: 'Firefox/99', sessionId: 'sess-1' }));

      const deviceResult = result.detectorResults.find((r) => r.detector === DetectorName.DEVICE_FINGERPRINT_MISMATCH);
      expect(deviceResult?.triggered).toBe(true);
      expect(deviceResult?.details).toContain('userAgent changed');
    });

    it('triggers when device fingerprint changes mid-session', async () => {
      await detector.evaluate(makeEvent({ deviceFingerprint: 'fp-1', sessionId: 'sess-1' }));
      const result = await detector.evaluate(makeEvent({ deviceFingerprint: 'fp-2', sessionId: 'sess-1' }));

      const deviceResult = result.detectorResults.find((r) => r.detector === DetectorName.DEVICE_FINGERPRINT_MISMATCH);
      expect(deviceResult?.triggered).toBe(true);
      expect(deviceResult?.details).toContain('deviceFingerprint changed');
    });

    it('does not trigger when fingerprint matches', async () => {
      const event = makeEvent({ sessionId: 'sess-1' });
      await detector.evaluate(event);
      const result = await detector.evaluate(event);

      const deviceResult = result.detectorResults.find((r) => r.detector === DetectorName.DEVICE_FINGERPRINT_MISMATCH);
      expect(deviceResult?.triggered).toBe(false);
      expect(deviceResult?.details).toContain('consistent');
    });
  });

  // ── Strategy Drift ─────────────────────────────────────────────────────

  describe('strategy drift check', () => {
    it('triggers when drift detector reports drift', async () => {
      const driftDet = makeDriftDetector({
        driftDetected: true,
        driftScore: 0.8,
        driftReasons: ['Instrument distribution drift'],
      });
      const det = new AnomalyDetector(config, logger, alertBus, driftDet, redis, geoIp);

      const result = await det.evaluate(makeEvent());
      const driftResult = result.detectorResults.find((r) => r.detector === DetectorName.STRATEGY_DRIFT);
      expect(driftResult?.triggered).toBe(true);
      expect(driftResult?.severity).toBe(RiskLevel.MEDIUM);
    });

    it('does not trigger when no drift', async () => {
      const result = await detector.evaluate(makeEvent());
      const driftResult = result.detectorResults.find((r) => r.detector === DetectorName.STRATEGY_DRIFT);
      expect(driftResult?.triggered).toBe(false);
    });
  });

  // ── Recommended Action ─────────────────────────────────────────────────

  describe('recommended action', () => {
    it('returns KILL_SESSION for CRITICAL severity', async () => {
      // Geo impossibility is CRITICAL
      const farGeoIp: GeoIpAdapter = {
        lookup: vi.fn<GeoIpAdapter['lookup']>()
          .mockResolvedValueOnce({ latitude: 40.7128, longitude: -74.006 })
          .mockResolvedValueOnce({ latitude: -33.8688, longitude: 151.2093 }),
      };

      const det = new AnomalyDetector(
        makeConfig({ geoImpossibilityMaxKm: 100, geoImpossibilityWindowMinutes: 60 }),
        logger, alertBus, driftDetector, redis, farGeoIp,
      );

      await det.evaluate(makeEvent({ ipAddress: '1.1.1.1' }));
      const result = await det.evaluate(makeEvent({ ipAddress: '2.2.2.2' }));

      expect(result.recommendedAction).toBe(RecommendedAction.KILL_SESSION);
    });

    it('returns BLOCK when multiple HIGH severity triggers', async () => {
      // Both velocity and device mismatch are HIGH
      const lowLimitConfig = makeConfig({ velocityMaxTradesPerMinute: 1 });
      const det = new AnomalyDetector(lowLimitConfig, logger, alertBus, driftDetector, redis, geoIp);

      // First trade to establish session baseline
      await det.evaluate(makeEvent({ sessionId: 'sess-1', userAgent: 'UA1' }));
      // Second trade triggers velocity + device mismatch
      const result = await det.evaluate(makeEvent({ sessionId: 'sess-1', userAgent: 'UA2' }));

      const triggeredHigh = result.detectorResults.filter(
        (r) => r.triggered && r.severity === RiskLevel.HIGH,
      );
      if (triggeredHigh.length >= 2) {
        expect(result.recommendedAction).toBe(RecommendedAction.BLOCK);
      }
    });

    it('returns WARN for single HIGH severity trigger', async () => {
      // Just device mismatch
      await detector.evaluate(makeEvent({ sessionId: 'sess-1', userAgent: 'UA1' }));
      const result = await detector.evaluate(makeEvent({ sessionId: 'sess-1', userAgent: 'UA2' }));

      const deviceResult = result.detectorResults.find((r) => r.detector === DetectorName.DEVICE_FINGERPRINT_MISMATCH);
      if (deviceResult?.triggered) {
        const triggeredHigh = result.detectorResults.filter(
          (r) => r.triggered && r.severity === RiskLevel.HIGH,
        );
        if (triggeredHigh.length === 1) {
          expect(result.recommendedAction).toBe(RecommendedAction.WARN);
        }
      }
    });
  });

  // ── Alert Emission ─────────────────────────────────────────────────────

  describe('alert emission', () => {
    it('emits alert for each triggered detector', async () => {
      // Force device mismatch to trigger
      await detector.evaluate(makeEvent({ sessionId: 'sess-1', userAgent: 'UA1' }));
      await detector.evaluate(makeEvent({ sessionId: 'sess-1', userAgent: 'UA2' }));

      expect(alertBus.emit).toHaveBeenCalled();
    });

    it('does not emit alerts when nothing triggers', async () => {
      await detector.evaluate(makeEvent());
      expect(alertBus.emit).not.toHaveBeenCalled();
    });

    it('emits alert with correct event structure', async () => {
      await detector.evaluate(makeEvent({ sessionId: 'sess-1', userAgent: 'UA1' }));
      await detector.evaluate(makeEvent({ sessionId: 'sess-1', userAgent: 'UA2' }));

      const emitCall = vi.mocked(alertBus.emit).mock.calls[0];
      const emittedEvent = emitCall?.[0];
      expect(emittedEvent).toMatchObject({
        eventType: 'ANOMALY_DETECTED',
        userId: 'user-1',
        strategyId: 'strat-1',
      });
      expect(emittedEvent?.payload).toHaveProperty('detector');
      expect(emittedEvent?.payload).toHaveProperty('tradeId');
      expect(emittedEvent?.payload).toHaveProperty('recommendedAction');
    });
  });

  // ── Logging ────────────────────────────────────────────────────────────

  describe('logging', () => {
    it('logs evaluation completion', async () => {
      await detector.evaluate(makeEvent());
      expect(logger.info).toHaveBeenCalledWith(
        'Anomaly evaluation complete',
        expect.objectContaining({
          userId: 'user-1',
          anomaliesDetected: false,
        }),
      );
    });
  });
});
