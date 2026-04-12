import { z } from 'zod';

// ─── Enums ───────────────────────────────────────────────────────────────────

export enum SecurityEventType {
  AUTH_SUCCESS = 'AUTH_SUCCESS',
  AUTH_FAILURE = 'AUTH_FAILURE',
  SESSION_MISMATCH = 'SESSION_MISMATCH',
  MFA_REQUIRED = 'MFA_REQUIRED',
  MFA_SUCCESS = 'MFA_SUCCESS',
  MFA_FAILURE = 'MFA_FAILURE',
  DEVICE_TRUST_GRANTED = 'DEVICE_TRUST_GRANTED',
  DEVICE_TRUST_DENIED = 'DEVICE_TRUST_DENIED',
  INPUT_SANITIZED = 'INPUT_SANITIZED',
  INJECTION_DETECTED = 'INJECTION_DETECTED',
  CONTEXT_INTEGRITY_FAILURE = 'CONTEXT_INTEGRITY_FAILURE',
  FEED_CONSENSUS_FAILURE = 'FEED_CONSENSUS_FAILURE',
  FEED_SIGNATURE_INVALID = 'FEED_SIGNATURE_INVALID',
  FEED_DATA_STALE = 'FEED_DATA_STALE',
  FEED_ANOMALY_DETECTED = 'FEED_ANOMALY_DETECTED',
  ACTION_ALLOWED = 'ACTION_ALLOWED',
  ACTION_BLOCKED = 'ACTION_BLOCKED',
  SANITY_CHECK_FAILED = 'SANITY_CHECK_FAILED',
  DUPLICATE_ORDER_DETECTED = 'DUPLICATE_ORDER_DETECTED',
  CIRCUIT_BREAKER_OPEN = 'CIRCUIT_BREAKER_OPEN',
  CIRCUIT_BREAKER_CLOSED = 'CIRCUIT_BREAKER_CLOSED',
  CIRCUIT_BREAKER_HALF_OPEN = 'CIRCUIT_BREAKER_HALF_OPEN',
  KILL_SWITCH_TRIGGERED = 'KILL_SWITCH_TRIGGERED',
  KILL_SWITCH_RESET = 'KILL_SWITCH_RESET',
  POSITION_LIMIT_BREACHED = 'POSITION_LIMIT_BREACHED',
  LOSS_LIMIT_BREACHED = 'LOSS_LIMIT_BREACHED',
  CONFIRMATION_REQUIRED = 'CONFIRMATION_REQUIRED',
  CONFIRMATION_APPROVED = 'CONFIRMATION_APPROVED',
  CONFIRMATION_EXPIRED = 'CONFIRMATION_EXPIRED',
  WASH_TRADE_DETECTED = 'WASH_TRADE_DETECTED',
  LAYERING_DETECTED = 'LAYERING_DETECTED',
  SHORT_SELL_BLOCKED = 'SHORT_SELL_BLOCKED',
  TRADE_REPORTED = 'TRADE_REPORTED',
  RATE_LIMIT_BREACHED = 'RATE_LIMIT_BREACHED',
  EXCHANGE_QUOTA_WARNING = 'EXCHANGE_QUOTA_WARNING',
  SECRET_LOADED = 'SECRET_LOADED',
  SECRET_ROTATION_DETECTED = 'SECRET_ROTATION_DETECTED',
  DEAD_MANS_SWITCH_TRIGGERED = 'DEAD_MANS_SWITCH_TRIGGERED',
  AUDIT_CHAIN_VALID = 'AUDIT_CHAIN_VALID',
  AUDIT_CHAIN_INVALID = 'AUDIT_CHAIN_INVALID',
  ANOMALY_DETECTED = 'ANOMALY_DETECTED',
  STRATEGY_DRIFT_DETECTED = 'STRATEGY_DRIFT_DETECTED',
  ALERT_EMITTED = 'ALERT_EMITTED',
}

export enum RiskLevel {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

export enum SourceTrust {
  INTERNAL = 'INTERNAL',
  VERIFIED_EXTERNAL = 'VERIFIED_EXTERNAL',
  UNVERIFIED_EXTERNAL = 'UNVERIFIED_EXTERNAL',
}

// ─── Zod Enums ───────────────────────────────────────────────────────────────

export const SecurityEventTypeSchema = z.nativeEnum(SecurityEventType);
export const RiskLevelSchema = z.nativeEnum(RiskLevel);
export const SourceTrustSchema = z.nativeEnum(SourceTrust);

// ─── Base event fields ───────────────────────────────────────────────────────

const baseEventFields = {
  timestamp: z.string().datetime().describe('ISO-8601 timestamp of the event'),
  correlationId: z.string().uuid().describe('Unique correlation ID linking related events'),
  riskLevel: RiskLevelSchema.describe('Assessed risk level of this event'),
};

// ─── Event-specific payload schemas ──────────────────────────────────────────

export const AuthSuccessPayloadSchema = z.object({
  userId: z.string(),
  ip: z.string(),
  userAgent: z.string(),
  method: z.enum(['jwt', 'api_key', 'oauth']),
});

export const AuthFailurePayloadSchema = z.object({
  userId: z.string().optional(),
  ip: z.string(),
  userAgent: z.string(),
  reason: z.string(),
  attemptCount: z.number().int().nonnegative(),
});

export const SessionMismatchPayloadSchema = z.object({
  userId: z.string(),
  expectedSessionId: z.string(),
  actualSessionId: z.string(),
  ip: z.string(),
});

export const MfaRequiredPayloadSchema = z.object({
  userId: z.string(),
  triggerAction: z.string(),
  riskScore: z.number(),
});

export const MfaSuccessPayloadSchema = z.object({
  userId: z.string(),
  method: z.enum(['totp', 'sms', 'email', 'hardware_key']),
});

export const MfaFailurePayloadSchema = z.object({
  userId: z.string(),
  method: z.enum(['totp', 'sms', 'email', 'hardware_key']),
  attemptCount: z.number().int().nonnegative(),
  reason: z.string(),
});

export const DeviceTrustGrantedPayloadSchema = z.object({
  userId: z.string(),
  deviceFingerprint: z.string(),
  trustScore: z.number(),
});

export const DeviceTrustDeniedPayloadSchema = z.object({
  userId: z.string(),
  deviceFingerprint: z.string(),
  trustScore: z.number(),
  reason: z.string(),
});

export const InputSanitizedPayloadSchema = z.object({
  field: z.string(),
  originalLength: z.number().int(),
  sanitizedLength: z.number().int(),
  patternsMatched: z.array(z.string()),
});

export const InjectionDetectedPayloadSchema = z.object({
  field: z.string(),
  injectionType: z.enum(['sql', 'xss', 'command', 'prompt', 'path_traversal']),
  snippet: z.string(),
  score: z.number(),
  source: SourceTrustSchema,
});

export const ContextIntegrityFailurePayloadSchema = z.object({
  strategyId: z.string(),
  expectedHash: z.string(),
  actualHash: z.string(),
  field: z.string(),
});

export const FeedConsensusFailurePayloadSchema = z.object({
  instrument: z.string(),
  feedPrices: z.record(z.string(), z.number()),
  divergencePercent: z.number(),
  threshold: z.number(),
});

export const FeedSignatureInvalidPayloadSchema = z.object({
  feedId: z.string(),
  provider: z.string(),
  reason: z.string(),
});

export const FeedDataStalePayloadSchema = z.object({
  feedId: z.string(),
  instrument: z.string(),
  lastUpdateMs: z.number(),
  stalenessMs: z.number(),
  thresholdMs: z.number(),
});

export const FeedAnomalyDetectedPayloadSchema = z.object({
  feedId: z.string(),
  instrument: z.string(),
  currentValue: z.number(),
  expectedRange: z.object({ low: z.number(), high: z.number() }),
  stdDevsAway: z.number(),
});

export const ActionAllowedPayloadSchema = z.object({
  actionType: z.string(),
  strategyId: z.string(),
  instrument: z.string().optional(),
  checksPerformed: z.array(z.string()),
});

export const ActionBlockedPayloadSchema = z.object({
  actionType: z.string(),
  strategyId: z.string(),
  instrument: z.string().optional(),
  reason: z.string(),
  violatedRule: z.string(),
});

export const SanityCheckFailedPayloadSchema = z.object({
  actionType: z.string(),
  strategyId: z.string(),
  instrument: z.string(),
  field: z.string(),
  value: z.number(),
  limit: z.number(),
  reason: z.string(),
});

export const DuplicateOrderDetectedPayloadSchema = z.object({
  clientOrderId: z.string(),
  instrument: z.string(),
  strategyId: z.string(),
  existingOrderId: z.string(),
});

export const CircuitBreakerOpenPayloadSchema = z.object({
  breakerName: z.string(),
  reason: z.string(),
  threshold: z.number(),
  currentCount: z.number(),
});

export const CircuitBreakerClosedPayloadSchema = z.object({
  breakerName: z.string(),
  recoveryDurationMs: z.number(),
});

export const CircuitBreakerHalfOpenPayloadSchema = z.object({
  breakerName: z.string(),
  testAction: z.string(),
});

export const KillSwitchTriggeredPayloadSchema = z.object({
  triggeredBy: z.string(),
  reason: z.string(),
  drawdownPercent: z.number().optional(),
  positionsClosed: z.number().int().optional(),
});

export const KillSwitchResetPayloadSchema = z.object({
  resetBy: z.string(),
  reason: z.string(),
});

export const PositionLimitBreachedPayloadSchema = z.object({
  instrument: z.string(),
  strategyId: z.string(),
  currentQuantity: z.number(),
  attemptedQuantity: z.number(),
  limit: z.number(),
});

export const LossLimitBreachedPayloadSchema = z.object({
  strategyId: z.string(),
  currentDrawdownPercent: z.number(),
  limitPercent: z.number(),
  unrealizedPnl: z.number(),
});

export const ConfirmationRequiredPayloadSchema = z.object({
  actionType: z.string(),
  instrument: z.string(),
  notionalValue: z.number(),
  threshold: z.number(),
  confirmationId: z.string().uuid(),
  expiresAt: z.string().datetime(),
});

export const ConfirmationApprovedPayloadSchema = z.object({
  confirmationId: z.string().uuid(),
  approvedBy: z.string(),
  actionType: z.string(),
});

export const ConfirmationExpiredPayloadSchema = z.object({
  confirmationId: z.string().uuid(),
  actionType: z.string(),
  instrument: z.string(),
});

export const WashTradeDetectedPayloadSchema = z.object({
  instrument: z.string(),
  buyOrderId: z.string(),
  sellOrderId: z.string(),
  strategyId: z.string(),
  windowMs: z.number(),
});

export const LayeringDetectedPayloadSchema = z.object({
  instrument: z.string(),
  strategyId: z.string(),
  cancelCount: z.number().int(),
  orderCount: z.number().int(),
  cancelRatio: z.number(),
  windowMs: z.number(),
});

export const ShortSellBlockedPayloadSchema = z.object({
  instrument: z.string(),
  strategyId: z.string(),
  reason: z.string(),
});

export const TradeReportedPayloadSchema = z.object({
  tradeId: z.string(),
  instrument: z.string(),
  side: z.enum(['BUY', 'SELL']),
  quantity: z.number(),
  price: z.number(),
  venue: z.string(),
  reportedTo: z.string(),
});

export const RateLimitBreachedPayloadSchema = z.object({
  level: z.enum(['user', 'strategy', 'instrument', 'exchange']),
  identifier: z.string(),
  requestCount: z.number().int(),
  limit: z.number().int(),
  windowMs: z.number(),
});

export const ExchangeQuotaWarningPayloadSchema = z.object({
  exchange: z.string(),
  usedPercent: z.number(),
  remainingRequests: z.number().int(),
  resetAtMs: z.number(),
});

export const SecretLoadedPayloadSchema = z.object({
  secretName: z.string(),
  provider: z.string(),
  version: z.string().optional(),
});

export const SecretRotationDetectedPayloadSchema = z.object({
  secretName: z.string(),
  previousVersion: z.string().optional(),
  newVersion: z.string(),
});

export const DeadMansSwitchTriggeredPayloadSchema = z.object({
  lastHeartbeatAt: z.string().datetime(),
  timeoutSeconds: z.number(),
  elapsedSeconds: z.number(),
});

export const AuditChainValidPayloadSchema = z.object({
  chainLength: z.number().int(),
  lastHash: z.string(),
  validatedAt: z.string().datetime(),
});

export const AuditChainInvalidPayloadSchema = z.object({
  brokenAtIndex: z.number().int(),
  expectedHash: z.string(),
  actualHash: z.string(),
});

export const AnomalyDetectedPayloadSchema = z.object({
  detectorName: z.string(),
  metric: z.string(),
  currentValue: z.number(),
  expectedValue: z.number(),
  stdDevsAway: z.number(),
  windowSize: z.number().int(),
});

export const StrategyDriftDetectedPayloadSchema = z.object({
  strategyId: z.string(),
  metric: z.string(),
  baselineValue: z.number(),
  currentValue: z.number(),
  driftPercent: z.number(),
});

export const AlertEmittedPayloadSchema = z.object({
  alertType: z.string(),
  channel: z.enum(['webhook', 'slack', 'email', 'pagerduty']),
  destination: z.string(),
  messagePreview: z.string(),
  delivered: z.boolean(),
});

// ─── Individual event schemas (discriminated on eventType) ───────────────────

const makeEventSchema = <T extends SecurityEventType, P extends z.ZodTypeAny>(
  eventType: T,
  payloadSchema: P,
) =>
  z.object({
    eventType: z.literal(eventType),
    ...baseEventFields,
    payload: payloadSchema,
  });

export const AuthSuccessEventSchema = makeEventSchema(SecurityEventType.AUTH_SUCCESS, AuthSuccessPayloadSchema);
export const AuthFailureEventSchema = makeEventSchema(SecurityEventType.AUTH_FAILURE, AuthFailurePayloadSchema);
export const SessionMismatchEventSchema = makeEventSchema(SecurityEventType.SESSION_MISMATCH, SessionMismatchPayloadSchema);
export const MfaRequiredEventSchema = makeEventSchema(SecurityEventType.MFA_REQUIRED, MfaRequiredPayloadSchema);
export const MfaSuccessEventSchema = makeEventSchema(SecurityEventType.MFA_SUCCESS, MfaSuccessPayloadSchema);
export const MfaFailureEventSchema = makeEventSchema(SecurityEventType.MFA_FAILURE, MfaFailurePayloadSchema);
export const DeviceTrustGrantedEventSchema = makeEventSchema(SecurityEventType.DEVICE_TRUST_GRANTED, DeviceTrustGrantedPayloadSchema);
export const DeviceTrustDeniedEventSchema = makeEventSchema(SecurityEventType.DEVICE_TRUST_DENIED, DeviceTrustDeniedPayloadSchema);
export const InputSanitizedEventSchema = makeEventSchema(SecurityEventType.INPUT_SANITIZED, InputSanitizedPayloadSchema);
export const InjectionDetectedEventSchema = makeEventSchema(SecurityEventType.INJECTION_DETECTED, InjectionDetectedPayloadSchema);
export const ContextIntegrityFailureEventSchema = makeEventSchema(SecurityEventType.CONTEXT_INTEGRITY_FAILURE, ContextIntegrityFailurePayloadSchema);
export const FeedConsensusFailureEventSchema = makeEventSchema(SecurityEventType.FEED_CONSENSUS_FAILURE, FeedConsensusFailurePayloadSchema);
export const FeedSignatureInvalidEventSchema = makeEventSchema(SecurityEventType.FEED_SIGNATURE_INVALID, FeedSignatureInvalidPayloadSchema);
export const FeedDataStaleEventSchema = makeEventSchema(SecurityEventType.FEED_DATA_STALE, FeedDataStalePayloadSchema);
export const FeedAnomalyDetectedEventSchema = makeEventSchema(SecurityEventType.FEED_ANOMALY_DETECTED, FeedAnomalyDetectedPayloadSchema);
export const ActionAllowedEventSchema = makeEventSchema(SecurityEventType.ACTION_ALLOWED, ActionAllowedPayloadSchema);
export const ActionBlockedEventSchema = makeEventSchema(SecurityEventType.ACTION_BLOCKED, ActionBlockedPayloadSchema);
export const SanityCheckFailedEventSchema = makeEventSchema(SecurityEventType.SANITY_CHECK_FAILED, SanityCheckFailedPayloadSchema);
export const DuplicateOrderDetectedEventSchema = makeEventSchema(SecurityEventType.DUPLICATE_ORDER_DETECTED, DuplicateOrderDetectedPayloadSchema);
export const CircuitBreakerOpenEventSchema = makeEventSchema(SecurityEventType.CIRCUIT_BREAKER_OPEN, CircuitBreakerOpenPayloadSchema);
export const CircuitBreakerClosedEventSchema = makeEventSchema(SecurityEventType.CIRCUIT_BREAKER_CLOSED, CircuitBreakerClosedPayloadSchema);
export const CircuitBreakerHalfOpenEventSchema = makeEventSchema(SecurityEventType.CIRCUIT_BREAKER_HALF_OPEN, CircuitBreakerHalfOpenPayloadSchema);
export const KillSwitchTriggeredEventSchema = makeEventSchema(SecurityEventType.KILL_SWITCH_TRIGGERED, KillSwitchTriggeredPayloadSchema);
export const KillSwitchResetEventSchema = makeEventSchema(SecurityEventType.KILL_SWITCH_RESET, KillSwitchResetPayloadSchema);
export const PositionLimitBreachedEventSchema = makeEventSchema(SecurityEventType.POSITION_LIMIT_BREACHED, PositionLimitBreachedPayloadSchema);
export const LossLimitBreachedEventSchema = makeEventSchema(SecurityEventType.LOSS_LIMIT_BREACHED, LossLimitBreachedPayloadSchema);
export const ConfirmationRequiredEventSchema = makeEventSchema(SecurityEventType.CONFIRMATION_REQUIRED, ConfirmationRequiredPayloadSchema);
export const ConfirmationApprovedEventSchema = makeEventSchema(SecurityEventType.CONFIRMATION_APPROVED, ConfirmationApprovedPayloadSchema);
export const ConfirmationExpiredEventSchema = makeEventSchema(SecurityEventType.CONFIRMATION_EXPIRED, ConfirmationExpiredPayloadSchema);
export const WashTradeDetectedEventSchema = makeEventSchema(SecurityEventType.WASH_TRADE_DETECTED, WashTradeDetectedPayloadSchema);
export const LayeringDetectedEventSchema = makeEventSchema(SecurityEventType.LAYERING_DETECTED, LayeringDetectedPayloadSchema);
export const ShortSellBlockedEventSchema = makeEventSchema(SecurityEventType.SHORT_SELL_BLOCKED, ShortSellBlockedPayloadSchema);
export const TradeReportedEventSchema = makeEventSchema(SecurityEventType.TRADE_REPORTED, TradeReportedPayloadSchema);
export const RateLimitBreachedEventSchema = makeEventSchema(SecurityEventType.RATE_LIMIT_BREACHED, RateLimitBreachedPayloadSchema);
export const ExchangeQuotaWarningEventSchema = makeEventSchema(SecurityEventType.EXCHANGE_QUOTA_WARNING, ExchangeQuotaWarningPayloadSchema);
export const SecretLoadedEventSchema = makeEventSchema(SecurityEventType.SECRET_LOADED, SecretLoadedPayloadSchema);
export const SecretRotationDetectedEventSchema = makeEventSchema(SecurityEventType.SECRET_ROTATION_DETECTED, SecretRotationDetectedPayloadSchema);
export const DeadMansSwitchTriggeredEventSchema = makeEventSchema(SecurityEventType.DEAD_MANS_SWITCH_TRIGGERED, DeadMansSwitchTriggeredPayloadSchema);
export const AuditChainValidEventSchema = makeEventSchema(SecurityEventType.AUDIT_CHAIN_VALID, AuditChainValidPayloadSchema);
export const AuditChainInvalidEventSchema = makeEventSchema(SecurityEventType.AUDIT_CHAIN_INVALID, AuditChainInvalidPayloadSchema);
export const AnomalyDetectedEventSchema = makeEventSchema(SecurityEventType.ANOMALY_DETECTED, AnomalyDetectedPayloadSchema);
export const StrategyDriftDetectedEventSchema = makeEventSchema(SecurityEventType.STRATEGY_DRIFT_DETECTED, StrategyDriftDetectedPayloadSchema);
export const AlertEmittedEventSchema = makeEventSchema(SecurityEventType.ALERT_EMITTED, AlertEmittedPayloadSchema);

// ─── Discriminated union schema ──────────────────────────────────────────────

export const SecurityEventSchema = z.discriminatedUnion('eventType', [
  AuthSuccessEventSchema,
  AuthFailureEventSchema,
  SessionMismatchEventSchema,
  MfaRequiredEventSchema,
  MfaSuccessEventSchema,
  MfaFailureEventSchema,
  DeviceTrustGrantedEventSchema,
  DeviceTrustDeniedEventSchema,
  InputSanitizedEventSchema,
  InjectionDetectedEventSchema,
  ContextIntegrityFailureEventSchema,
  FeedConsensusFailureEventSchema,
  FeedSignatureInvalidEventSchema,
  FeedDataStaleEventSchema,
  FeedAnomalyDetectedEventSchema,
  ActionAllowedEventSchema,
  ActionBlockedEventSchema,
  SanityCheckFailedEventSchema,
  DuplicateOrderDetectedEventSchema,
  CircuitBreakerOpenEventSchema,
  CircuitBreakerClosedEventSchema,
  CircuitBreakerHalfOpenEventSchema,
  KillSwitchTriggeredEventSchema,
  KillSwitchResetEventSchema,
  PositionLimitBreachedEventSchema,
  LossLimitBreachedEventSchema,
  ConfirmationRequiredEventSchema,
  ConfirmationApprovedEventSchema,
  ConfirmationExpiredEventSchema,
  WashTradeDetectedEventSchema,
  LayeringDetectedEventSchema,
  ShortSellBlockedEventSchema,
  TradeReportedEventSchema,
  RateLimitBreachedEventSchema,
  ExchangeQuotaWarningEventSchema,
  SecretLoadedEventSchema,
  SecretRotationDetectedEventSchema,
  DeadMansSwitchTriggeredEventSchema,
  AuditChainValidEventSchema,
  AuditChainInvalidEventSchema,
  AnomalyDetectedEventSchema,
  StrategyDriftDetectedEventSchema,
  AlertEmittedEventSchema,
]);

// ─── Inferred types ──────────────────────────────────────────────────────────

export type SecurityEvent = z.infer<typeof SecurityEventSchema>;

export type AuthSuccessEvent = z.infer<typeof AuthSuccessEventSchema>;
export type AuthFailureEvent = z.infer<typeof AuthFailureEventSchema>;
export type SessionMismatchEvent = z.infer<typeof SessionMismatchEventSchema>;
export type MfaRequiredEvent = z.infer<typeof MfaRequiredEventSchema>;
export type MfaSuccessEvent = z.infer<typeof MfaSuccessEventSchema>;
export type MfaFailureEvent = z.infer<typeof MfaFailureEventSchema>;
export type DeviceTrustGrantedEvent = z.infer<typeof DeviceTrustGrantedEventSchema>;
export type DeviceTrustDeniedEvent = z.infer<typeof DeviceTrustDeniedEventSchema>;
export type InputSanitizedEvent = z.infer<typeof InputSanitizedEventSchema>;
export type InjectionDetectedEvent = z.infer<typeof InjectionDetectedEventSchema>;
export type ContextIntegrityFailureEvent = z.infer<typeof ContextIntegrityFailureEventSchema>;
export type FeedConsensusFailureEvent = z.infer<typeof FeedConsensusFailureEventSchema>;
export type FeedSignatureInvalidEvent = z.infer<typeof FeedSignatureInvalidEventSchema>;
export type FeedDataStaleEvent = z.infer<typeof FeedDataStaleEventSchema>;
export type FeedAnomalyDetectedEvent = z.infer<typeof FeedAnomalyDetectedEventSchema>;
export type ActionAllowedEvent = z.infer<typeof ActionAllowedEventSchema>;
export type ActionBlockedEvent = z.infer<typeof ActionBlockedEventSchema>;
export type SanityCheckFailedEvent = z.infer<typeof SanityCheckFailedEventSchema>;
export type DuplicateOrderDetectedEvent = z.infer<typeof DuplicateOrderDetectedEventSchema>;
export type CircuitBreakerOpenEvent = z.infer<typeof CircuitBreakerOpenEventSchema>;
export type CircuitBreakerClosedEvent = z.infer<typeof CircuitBreakerClosedEventSchema>;
export type CircuitBreakerHalfOpenEvent = z.infer<typeof CircuitBreakerHalfOpenEventSchema>;
export type KillSwitchTriggeredEvent = z.infer<typeof KillSwitchTriggeredEventSchema>;
export type KillSwitchResetEvent = z.infer<typeof KillSwitchResetEventSchema>;
export type PositionLimitBreachedEvent = z.infer<typeof PositionLimitBreachedEventSchema>;
export type LossLimitBreachedEvent = z.infer<typeof LossLimitBreachedEventSchema>;
export type ConfirmationRequiredEvent = z.infer<typeof ConfirmationRequiredEventSchema>;
export type ConfirmationApprovedEvent = z.infer<typeof ConfirmationApprovedEventSchema>;
export type ConfirmationExpiredEvent = z.infer<typeof ConfirmationExpiredEventSchema>;
export type WashTradeDetectedEvent = z.infer<typeof WashTradeDetectedEventSchema>;
export type LayeringDetectedEvent = z.infer<typeof LayeringDetectedEventSchema>;
export type ShortSellBlockedEvent = z.infer<typeof ShortSellBlockedEventSchema>;
export type TradeReportedEvent = z.infer<typeof TradeReportedEventSchema>;
export type RateLimitBreachedEvent = z.infer<typeof RateLimitBreachedEventSchema>;
export type ExchangeQuotaWarningEvent = z.infer<typeof ExchangeQuotaWarningEventSchema>;
export type SecretLoadedEvent = z.infer<typeof SecretLoadedEventSchema>;
export type SecretRotationDetectedEvent = z.infer<typeof SecretRotationDetectedEventSchema>;
export type DeadMansSwitchTriggeredEvent = z.infer<typeof DeadMansSwitchTriggeredEventSchema>;
export type AuditChainValidEvent = z.infer<typeof AuditChainValidEventSchema>;
export type AuditChainInvalidEvent = z.infer<typeof AuditChainInvalidEventSchema>;
export type AnomalyDetectedEvent = z.infer<typeof AnomalyDetectedEventSchema>;
export type StrategyDriftDetectedEvent = z.infer<typeof StrategyDriftDetectedEventSchema>;
export type AlertEmittedEvent = z.infer<typeof AlertEmittedEventSchema>;
