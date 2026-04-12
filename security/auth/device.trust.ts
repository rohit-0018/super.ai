import type { AgentAction } from '../types/actions.js';
import { AgentActionType } from '../types/actions.js';
import type { SecurityConfig } from '../types/config.js';

// ─── Interfaces ─────────────────────────────────────────────────────────────

export interface DeviceTrustRedisAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  setex(key: string, ttlSeconds: number, value: string): Promise<void>;
  del(key: string): Promise<void>;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEVICE_TRUST_PREFIX = 'device:trust:';
const DEVICE_TRUST_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days
const MAX_TRUST_SCORE = 100;

// ─── Action thresholds ──────────────────────────────────────────────────────

const ACTION_TRUST_THRESHOLDS: Record<AgentActionType, number> = {
  [AgentActionType.PlaceOrder]: 70,
  [AgentActionType.ModifyOrder]: 50,
  [AgentActionType.CancelOrder]: 30,
  [AgentActionType.ClosePosition]: 70,
  [AgentActionType.RequestHumanReview]: 0,
  [AgentActionType.NoAction]: 0,
};

// ─── DeviceTrustService ─────────────────────────────────────────────────────

export class DeviceTrustService {
  private readonly config: SecurityConfig;
  private readonly redis: DeviceTrustRedisAdapter;

  constructor(config: SecurityConfig, redis: DeviceTrustRedisAdapter) {
    this.config = config;
    this.redis = redis;
  }

  private redisKey(userId: string, deviceFingerprint: string): string {
    return `${DEVICE_TRUST_PREFIX}${userId}:${deviceFingerprint}`;
  }

  public async getScore(userId: string, deviceFingerprint: string): Promise<number> {
    const key = this.redisKey(userId, deviceFingerprint);
    const stored = await this.redis.get(key);

    if (stored === null) {
      return 0;
    }

    const score = Number(stored);
    if (Number.isNaN(score) || score < 0) {
      return 0;
    }

    return Math.min(score, MAX_TRUST_SCORE);
  }

  public async recordSuccessfulAuth(
    userId: string,
    deviceFingerprint: string,
  ): Promise<number> {
    const currentScore = await this.getScore(userId, deviceFingerprint);
    const increment = this.config.deviceTrustScoreIncrement;
    const newScore = Math.min(currentScore + increment, MAX_TRUST_SCORE);

    const key = this.redisKey(userId, deviceFingerprint);
    await this.redis.setex(key, DEVICE_TRUST_TTL_SECONDS, String(newScore));

    return newScore;
  }

  public isActionPermitted(score: number, action: AgentAction): boolean {
    const threshold = ACTION_TRUST_THRESHOLDS[action.type];

    // Also check against the global config threshold for high-risk actions
    const configThreshold = this.config.deviceTrustScoreThreshold;

    // For actions that require trust (threshold > 0), use the higher of
    // action-specific and config-level thresholds
    if (threshold > 0) {
      return score >= Math.max(threshold, configThreshold);
    }

    // For actions with threshold 0 (no trust required), always permit
    return true;
  }

  public async revokeDevice(
    userId: string,
    deviceFingerprint: string,
  ): Promise<void> {
    const key = this.redisKey(userId, deviceFingerprint);
    await this.redis.del(key);
  }
}
