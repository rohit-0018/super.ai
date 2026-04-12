import { RiskLevel, SecurityEventType } from '../types/events.js';
import type { AlertBus, AnomalyEvent } from './alert.bus.js';
import type {
  StrategyDriftDetector,
  ExecutedTrade,
  DriftCheckResult,
} from './strategy.drift.detector.js';

// ─── Interfaces ────────────────────────────────────────────────────────────

export interface AnomalyDetectorLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export interface AnomalyRedisAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  lpush(key: string, value: string): Promise<void>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  ltrim(key: string, start: number, stop: number): Promise<void>;
}

// ─── TradeExecutedEvent ────────────────────────────────────────────────────

export interface TradeExecutedEvent {
  readonly trade: ExecutedTrade;
  readonly userId: string;
  readonly sessionId: string;
  readonly ipAddress: string;
  readonly userAgent: string;
  readonly deviceFingerprint: string;
}

// ─── Config ────────────────────────────────────────────────────────────────

export interface AnomalyDetectorConfig {
  readonly velocityMaxTradesPerMinute: number;
  readonly highValueSpikeMultiplier: number;
  readonly geoImpossibilityMaxKm: number;
  readonly geoImpossibilityWindowMinutes: number;
  readonly driftThreshold: number;
}

// ─── Detector Results ──────────────────────────────────────────────────────

export enum DetectorName {
  VELOCITY = 'VELOCITY',
  HIGH_VALUE_SPIKE = 'HIGH_VALUE_SPIKE',
  GEO_IMPOSSIBILITY = 'GEO_IMPOSSIBILITY',
  DEVICE_FINGERPRINT_MISMATCH = 'DEVICE_FINGERPRINT_MISMATCH',
  STRATEGY_DRIFT = 'STRATEGY_DRIFT',
}

export interface DetectorResult {
  readonly detector: DetectorName;
  readonly triggered: boolean;
  readonly details: string;
  readonly severity: RiskLevel;
}

export enum RecommendedAction {
  ALLOW = 'ALLOW',
  WARN = 'WARN',
  BLOCK = 'BLOCK',
  KILL_SESSION = 'KILL_SESSION',
}

export interface AnomalyEvaluation {
  readonly anomaliesDetected: boolean;
  readonly detectorResults: readonly DetectorResult[];
  readonly recommendedAction: RecommendedAction;
}

// ─── GeoIP Adapter Interface ───────────────────────────────────────────────

export interface GeoCoordinates {
  readonly latitude: number;
  readonly longitude: number;
}

export interface GeoIpAdapter {
  lookup(ip: string): Promise<GeoCoordinates | null>;
}

// ─── Haversine ─────────────────────────────────────────────────────────────

const EARTH_RADIUS_KM = 6371;

export function haversineDistanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

// ─── IP Event for geo tracking ─────────────────────────────────────────────

interface IpEvent {
  readonly ip: string;
  readonly timestamp: string;
  readonly latitude: number;
  readonly longitude: number;
}

// ─── Session Info for device tracking ──────────────────────────────────────

interface SessionInfo {
  readonly userAgent: string;
  readonly deviceFingerprint: string;
}

// ─── AnomalyDetector ──────────────────────────────────────────────────────

const REDIS_PREFIX = 'security:anomaly:';

export class AnomalyDetector {
  private readonly config: AnomalyDetectorConfig;
  private readonly logger: AnomalyDetectorLogger;
  private readonly alertBus: AlertBus;
  private readonly driftDetector: StrategyDriftDetector;
  private readonly redis: AnomalyRedisAdapter;
  private readonly geoIp: GeoIpAdapter;

  constructor(
    config: AnomalyDetectorConfig,
    logger: AnomalyDetectorLogger,
    alertBus: AlertBus,
    driftDetector: StrategyDriftDetector,
    redis: AnomalyRedisAdapter,
    geoIp: GeoIpAdapter,
  ) {
    this.config = config;
    this.logger = logger;
    this.alertBus = alertBus;
    this.driftDetector = driftDetector;
    this.redis = redis;
    this.geoIp = geoIp;
  }

  async evaluate(event: TradeExecutedEvent): Promise<AnomalyEvaluation> {
    const [
      velocityResult,
      highValueResult,
      geoResult,
      deviceResult,
      driftResult,
    ] = await Promise.all([
      this.checkVelocity(event),
      this.checkHighValueSpike(event),
      this.checkGeoImpossibility(event),
      this.checkDeviceFingerprint(event),
      this.checkStrategyDrift(event),
    ]);

    const detectorResults: DetectorResult[] = [
      velocityResult,
      highValueResult,
      geoResult,
      deviceResult,
      driftResult,
    ];

    const triggeredResults = detectorResults.filter((r) => r.triggered);
    const anomaliesDetected = triggeredResults.length > 0;

    const recommendedAction = this.determineAction(triggeredResults);

    // Emit alert for each triggered detector
    for (const result of triggeredResults) {
      const anomalyEvent: AnomalyEvent = {
        eventType: SecurityEventType.ANOMALY_DETECTED,
        riskLevel: result.severity,
        userId: event.userId,
        strategyId: event.trade.strategyId,
        description: result.details,
        payload: {
          detector: result.detector,
          tradeId: event.trade.tradeId,
          recommendedAction,
        },
        timestamp: new Date().toISOString(),
      };
      await this.alertBus.emit(anomalyEvent);
    }

    this.logger.info('Anomaly evaluation complete', {
      userId: event.userId,
      tradeId: event.trade.tradeId,
      anomaliesDetected,
      triggeredCount: triggeredResults.length,
      recommendedAction,
    });

    return {
      anomaliesDetected,
      detectorResults,
      recommendedAction,
    };
  }

  // ── Velocity Check ───────────────────────────────────────────────────────

  private async checkVelocity(event: TradeExecutedEvent): Promise<DetectorResult> {
    const key = `${REDIS_PREFIX}velocity:${event.userId}`;
    const now = Date.now();
    const entry = JSON.stringify({ timestamp: now, tradeId: event.trade.tradeId });

    await this.redis.lpush(key, entry);
    // Keep last 200 entries max
    await this.redis.ltrim(key, 0, 199);

    const entries = await this.redis.lrange(key, 0, -1);
    const oneMinuteAgo = now - 60_000;
    let recentCount = 0;

    for (const raw of entries) {
      const parsed = JSON.parse(raw) as { timestamp: number };
      if (parsed.timestamp >= oneMinuteAgo) {
        recentCount++;
      }
    }

    const triggered = recentCount > this.config.velocityMaxTradesPerMinute;

    return {
      detector: DetectorName.VELOCITY,
      triggered,
      details: triggered
        ? `Velocity exceeded: ${recentCount} trades/minute (limit: ${this.config.velocityMaxTradesPerMinute})`
        : `Velocity normal: ${recentCount} trades/minute`,
      severity: triggered ? RiskLevel.HIGH : RiskLevel.LOW,
    };
  }

  // ── High Value Spike ─────────────────────────────────────────────────────

  private async checkHighValueSpike(event: TradeExecutedEvent): Promise<DetectorResult> {
    const key = `${REDIS_PREFIX}notionals:${event.userId}`;
    const notional = event.trade.notional;

    await this.redis.lpush(key, JSON.stringify({ notional, timestamp: Date.now() }));
    await this.redis.ltrim(key, 0, 999);

    const entries = await this.redis.lrange(key, 0, -1);
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

    let sum = 0;
    let count = 0;
    for (const raw of entries) {
      const parsed = JSON.parse(raw) as { notional: number; timestamp: number };
      if (parsed.timestamp >= thirtyDaysAgo) {
        sum += parsed.notional;
        count++;
      }
    }

    // Need at least 2 entries to compute a meaningful average (exclude current)
    if (count <= 1) {
      return {
        detector: DetectorName.HIGH_VALUE_SPIKE,
        triggered: false,
        details: 'Insufficient history for high value comparison',
        severity: RiskLevel.LOW,
      };
    }

    const avgNotional = (sum - notional) / (count - 1);
    const threshold = avgNotional * this.config.highValueSpikeMultiplier;
    const triggered = notional > threshold && avgNotional > 0;

    return {
      detector: DetectorName.HIGH_VALUE_SPIKE,
      triggered,
      details: triggered
        ? `High value spike: notional ${notional} exceeds ${this.config.highValueSpikeMultiplier}x avg (${avgNotional.toFixed(2)})`
        : `Notional ${notional} within normal range (avg: ${avgNotional.toFixed(2)})`,
      severity: triggered ? RiskLevel.HIGH : RiskLevel.LOW,
    };
  }

  // ── Geographic Impossibility ─────────────────────────────────────────────

  private async checkGeoImpossibility(event: TradeExecutedEvent): Promise<DetectorResult> {
    const coords = await this.geoIp.lookup(event.ipAddress);
    if (coords === null) {
      return {
        detector: DetectorName.GEO_IMPOSSIBILITY,
        triggered: false,
        details: 'Unable to resolve IP geolocation',
        severity: RiskLevel.LOW,
      };
    }

    const key = `${REDIS_PREFIX}geoip:${event.userId}`;
    const now = new Date().toISOString();
    const currentEvent: IpEvent = {
      ip: event.ipAddress,
      timestamp: now,
      latitude: coords.latitude,
      longitude: coords.longitude,
    };

    // Get previous IP events
    const raw = await this.redis.get(key);
    const previousEvents: IpEvent[] = raw !== null ? (JSON.parse(raw) as IpEvent[]) : [];

    // Check against recent events within the configured window
    const windowMs = this.config.geoImpossibilityWindowMinutes * 60_000;
    const windowStart = Date.now() - windowMs;

    let triggered = false;
    let maxDistance = 0;
    let details = 'No geographic impossibility detected';

    for (const prev of previousEvents) {
      const prevTime = new Date(prev.timestamp).getTime();
      if (prevTime >= windowStart && prev.ip !== event.ipAddress) {
        const distance = haversineDistanceKm(
          prev.latitude,
          prev.longitude,
          coords.latitude,
          coords.longitude,
        );
        if (distance > maxDistance) {
          maxDistance = distance;
        }
        if (distance > this.config.geoImpossibilityMaxKm) {
          triggered = true;
          details = `Geographic impossibility: ${distance.toFixed(0)}km between IPs ${prev.ip} and ${event.ipAddress} in ${this.config.geoImpossibilityWindowMinutes} minutes`;
        }
      }
    }

    // Store current event (keep last 20)
    previousEvents.push(currentEvent);
    const kept = previousEvents.slice(-20);
    await this.redis.set(key, JSON.stringify(kept), 86400);

    return {
      detector: DetectorName.GEO_IMPOSSIBILITY,
      triggered,
      details,
      severity: triggered ? RiskLevel.CRITICAL : RiskLevel.LOW,
    };
  }

  // ── Device Fingerprint Mismatch ──────────────────────────────────────────

  private async checkDeviceFingerprint(event: TradeExecutedEvent): Promise<DetectorResult> {
    const key = `${REDIS_PREFIX}session:${event.sessionId}`;
    const raw = await this.redis.get(key);

    if (raw === null) {
      // First trade in this session, record the baseline
      const sessionInfo: SessionInfo = {
        userAgent: event.userAgent,
        deviceFingerprint: event.deviceFingerprint,
      };
      await this.redis.set(key, JSON.stringify(sessionInfo), 86400);

      return {
        detector: DetectorName.DEVICE_FINGERPRINT_MISMATCH,
        triggered: false,
        details: 'First trade in session, baseline recorded',
        severity: RiskLevel.LOW,
      };
    }

    const baseline = JSON.parse(raw) as SessionInfo;
    const userAgentChanged = baseline.userAgent !== event.userAgent;
    const fingerprintChanged = baseline.deviceFingerprint !== event.deviceFingerprint;
    const triggered = userAgentChanged || fingerprintChanged;

    const reasons: string[] = [];
    if (userAgentChanged) {
      reasons.push(`userAgent changed from "${baseline.userAgent}" to "${event.userAgent}"`);
    }
    if (fingerprintChanged) {
      reasons.push(`deviceFingerprint changed from "${baseline.deviceFingerprint}" to "${event.deviceFingerprint}"`);
    }

    return {
      detector: DetectorName.DEVICE_FINGERPRINT_MISMATCH,
      triggered,
      details: triggered
        ? `Device mismatch mid-session: ${reasons.join('; ')}`
        : 'Device fingerprint consistent with session baseline',
      severity: triggered ? RiskLevel.HIGH : RiskLevel.LOW,
    };
  }

  // ── Strategy Drift ───────────────────────────────────────────────────────

  private async checkStrategyDrift(event: TradeExecutedEvent): Promise<DetectorResult> {
    const driftResult: DriftCheckResult = await this.driftDetector.check(
      event.trade.strategyId,
      [event.trade],
    );

    return {
      detector: DetectorName.STRATEGY_DRIFT,
      triggered: driftResult.driftDetected,
      details: driftResult.driftDetected
        ? `Strategy drift detected (score: ${driftResult.driftScore.toFixed(3)}): ${driftResult.driftReasons.join('; ')}`
        : `No strategy drift (score: ${driftResult.driftScore.toFixed(3)})`,
      severity: driftResult.driftDetected ? RiskLevel.MEDIUM : RiskLevel.LOW,
    };
  }

  // ── Determine Recommended Action ─────────────────────────────────────────

  private determineAction(triggeredResults: readonly DetectorResult[]): RecommendedAction {
    if (triggeredResults.length === 0) {
      return RecommendedAction.ALLOW;
    }

    const hasCritical = triggeredResults.some((r) => r.severity === RiskLevel.CRITICAL);
    const highCount = triggeredResults.filter((r) => r.severity === RiskLevel.HIGH).length;

    if (hasCritical) {
      return RecommendedAction.KILL_SESSION;
    }

    if (highCount >= 2) {
      return RecommendedAction.BLOCK;
    }

    if (highCount === 1) {
      return RecommendedAction.WARN;
    }

    return RecommendedAction.WARN;
  }
}
