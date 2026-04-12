// ─── Security Module — Public API ───────────────────────────────────────────
//
// Re-exports everything consumers need from the security module.
// ─────────────────────────────────────────────────────────────────────────────

// ── Bootstrap ───────────────────────────────────────────────────────────────

export { bootstrapSecurity, type SecurityMiddlewareStack } from './bootstrap.js';

// ── Types: Config ───────────────────────────────────────────────────────────

export { SecurityConfigSchema, type SecurityConfig } from './types/config.js';

// ── Types: Events ───────────────────────────────────────────────────────────

export {
  SecurityEventType,
  RiskLevel,
  SourceTrust,
  SecurityEventTypeSchema,
  RiskLevelSchema,
  SourceTrustSchema,
  SecurityEventSchema,
  type SecurityEvent,
  type AuthSuccessEvent,
  type AuthFailureEvent,
  type SessionMismatchEvent,
  type MfaRequiredEvent,
  type MfaSuccessEvent,
  type MfaFailureEvent,
  type DeviceTrustGrantedEvent,
  type DeviceTrustDeniedEvent,
  type InputSanitizedEvent,
  type InjectionDetectedEvent,
  type ContextIntegrityFailureEvent,
  type FeedConsensusFailureEvent,
  type FeedSignatureInvalidEvent,
  type FeedDataStaleEvent,
  type FeedAnomalyDetectedEvent,
  type ActionAllowedEvent,
  type ActionBlockedEvent,
  type SanityCheckFailedEvent,
  type DuplicateOrderDetectedEvent,
  type CircuitBreakerOpenEvent,
  type CircuitBreakerClosedEvent,
  type CircuitBreakerHalfOpenEvent,
  type KillSwitchTriggeredEvent,
  type KillSwitchResetEvent,
  type PositionLimitBreachedEvent,
  type LossLimitBreachedEvent,
  type ConfirmationRequiredEvent,
  type ConfirmationApprovedEvent,
  type ConfirmationExpiredEvent,
  type WashTradeDetectedEvent,
  type LayeringDetectedEvent,
  type ShortSellBlockedEvent,
  type TradeReportedEvent,
  type RateLimitBreachedEvent,
  type ExchangeQuotaWarningEvent,
  type SecretLoadedEvent,
  type SecretRotationDetectedEvent,
  type DeadMansSwitchTriggeredEvent,
  type AuditChainValidEvent,
  type AuditChainInvalidEvent,
  type AnomalyDetectedEvent,
  type StrategyDriftDetectedEvent,
  type AlertEmittedEvent,
} from './types/events.js';

// ── Types: Errors ───────────────────────────────────────────────────────────

export {
  SecurityErrorCode,
  SecurityError,
  AuthenticationError,
  AuthorizationError,
  SessionError,
  InjectionError,
  IntegrityError,
  FeedError,
  ActionBlockedError,
  RiskLimitError,
  CircuitBreakerError,
  ComplianceError,
  RateLimitError,
  SecretsError,
  AuditError,
  AnomalyError,
} from './types/errors.js';

// ── Types: Actions ──────────────────────────────────────────────────────────

export {
  AgentActionType,
  OrderSide,
  OrderType,
  AgentActionTypeSchema,
  OrderSideSchema,
  OrderTypeSchema,
  AgentActionSchema,
  PlaceOrderActionSchema,
  CancelOrderActionSchema,
  ModifyOrderActionSchema,
  ClosePositionActionSchema,
  RequestHumanReviewActionSchema,
  NoActionSchema,
  type AgentAction,
  type PlaceOrderAction,
  type CancelOrderAction,
  type ModifyOrderAction,
  type ClosePositionAction,
  type RequestHumanReviewAction,
  type NoAction,
} from './types/actions.js';

// ── Types: Risk ─────────────────────────────────────────────────────────────

export {
  CircuitBreakerState,
  CircuitBreakerStateSchema,
  CircuitBreakerSnapshotSchema,
  PositionSnapshotSchema,
  PortfolioSnapshotSchema,
  type CircuitBreakerSnapshot,
  type PositionSnapshot,
  type PortfolioSnapshot,
} from './types/risk.js';

// ── Rate Limiting ───────────────────────────────────────────────────────────

export { RedisAdapter } from './rate-limit/redis.adapter.js';
export { RateLimiter, type RateLimitResult, type RateLimitIdentifier } from './rate-limit/rate.limiter.js';
export {
  ExchangeQuotaAdapter,
  ExchangeQuotaConfigSchema,
  type ExchangeQuotaConfig,
  type QuotaCheckResult,
} from './rate-limit/exchange.quota.adapter.js';

// ── Audit ───────────────────────────────────────────────────────────────────

export {
  AuditLogger,
  JsonlFileWriter,
  NoopWriter,
  type LogWriter,
  type LogContext,
} from './audit/audit.logger.js';
export { HmacChain, type ChainVerificationResult } from './audit/hmac.chain.js';
export {
  ForensicsService,
  type SessionReplay,
  type SessionReplaySummary,
} from './audit/forensics.service.js';
export { LogEntrySchema, ResultStatus, type LogEntry } from './audit/log.entry.schema.js';

// ── Anomaly ─────────────────────────────────────────────────────────────────

export {
  AlertBus,
  WebhookAlertConsumer,
  SlackAlertConsumer,
  EmailAlertConsumer,
  LogAlertConsumer,
  type AlertConsumer,
  type AnomalyEvent,
  type HttpClient,
  type EmailTransport,
} from './anomaly/alert.bus.js';
export {
  AnomalyDetector,
  DetectorName,
  RecommendedAction,
  haversineDistanceKm,
  type AnomalyDetectorConfig,
  type TradeExecutedEvent,
  type DetectorResult,
  type AnomalyEvaluation,
  type GeoIpAdapter,
  type GeoCoordinates,
} from './anomaly/anomaly.detector.js';
export {
  StrategyDriftDetector,
  type ExecutedTrade,
  type DriftCheckResult,
  type TradeProfile,
  type DriftDetectorConfig,
} from './anomaly/strategy.drift.detector.js';

// ── Risk ────────────────────────────────────────────────────────────────────

export { KillSwitch, type KillSwitchScope } from './risk/kill.switch.js';
export { CircuitBreaker } from './risk/circuit.breaker.js';
export {
  RiskEngine,
  type RiskContext,
  type RiskEvaluation,
} from './risk/risk.engine.js';
export {
  PositionLimitsChecker,
  type LimitBreach,
  type LimitCheckResult,
} from './risk/position.limits.js';
export { LossMonitor } from './risk/loss.monitor.js';

// ── Secrets ─────────────────────────────────────────────────────────────────

export {
  SecretsLoader,
  type LoadedSecrets,
} from './secrets/secrets.loader.js';
export {
  AwsKmsAdapter,
  LocalKmsAdapter,
  type KmsAdapter,
  type KeyVersion,
} from './secrets/kms.adapter.js';
export { DeadMansSwitch } from './secrets/dead.mans.switch.js';
export { KeyRotationWatcher } from './secrets/key.rotation.watcher.js';

// ── Crypto ──────────────────────────────────────────────────────────────────

export {
  CryptoService,
  EncryptedValueSchema,
  type EncryptedValue,
} from './crypto/crypto.service.js';
export { SigningService } from './crypto/signing.service.js';

// ── Headers ─────────────────────────────────────────────────────────────────

export {
  createSecurityHeaders,
  type HeadersConfig,
  type CspConfig,
  type PermissionsPolicyConfig,
} from './headers/security.headers.js';
export { createCorsMiddleware } from './headers/cors.middleware.js';

// ── Auth ────────────────────────────────────────────────────────────────────

export {
  JwtValidator,
  ValidatedTokenSchema,
  TokenPairSchema,
  type ValidatedToken,
  type TokenPair,
} from './auth/jwt.validator.js';
export {
  SessionBinder,
  IncomingRequestSchema,
  BoundSessionSchema,
  type BoundSession,
  type IncomingRequest,
} from './auth/session.binder.js';
export {
  MfaGate,
  MfaChallengeSchema,
  type MfaChallenge,
} from './auth/mfa.gate.js';
export { DeviceTrustService } from './auth/device.trust.js';
export { TokenRotator } from './auth/token.rotator.js';

// ── Input ───────────────────────────────────────────────────────────────────

export {
  InputGuard,
  type RawInput,
  type SanitizedInput,
} from './input/input.guard.js';
export { PiiScrubber, PiiType, type PiiDetection, type ScrubResult } from './input/pii.scrubber.js';
export { InjectionDetector, type InjectionScore } from './input/injection.detector.js';
export {
  ContextIntegrityService,
  type SealedContext,
} from './input/context.integrity.js';
export { SourceTrustClassifier, type SourceTrustConfig } from './input/source.trust.classifier.js';

// ── Output ──────────────────────────────────────────────────────────────────

export { OutputFilter, type FilteredOutput } from './output/output.filter.js';
export { ActionAllowlist } from './output/action.allowlist.js';
export { SanityChecker, type SanityCheckResult, type SanityCheckerConfig } from './output/sanity.checker.js';
export { DuplicateDetector, type DuplicateCheckResult } from './output/duplicate.detector.js';

// ── Confirmation ────────────────────────────────────────────────────────────

export {
  ConfirmationGate,
  type EnforcementResult,
} from './confirmation/confirmation.gate.js';
export {
  ApprovalFlow,
  ConfirmationExpiredError,
  ConfirmationReplayError,
  ConfirmationOwnershipError,
  ConfirmationSignatureError,
  type ApprovalChallenge,
  type ApprovedAction,
} from './confirmation/approval.flow.js';

// ── Compliance ──────────────────────────────────────────────────────────────

export {
  WashTradeDetector,
  type WashTradeCheckResult,
} from './compliance/wash.trade.detector.js';
export {
  LayeringDetector,
  type LayeringCheckResult,
} from './compliance/layering.detector.js';
export {
  ShortSellControl,
  AccountType,
  type ShortSellCheckResult,
} from './compliance/short.sell.control.js';
export {
  TradeReporter,
  LocalJsonlTradeReporter,
  WebhookTradeReporter,
  type TradeReportingAdapter,
  type ExecutedTrade as ComplianceExecutedTrade,
} from './compliance/trade.reporter.js';

// ── Market Data ─────────────────────────────────────────────────────────────

export {
  MarketDataGuard,
  type ValidatedMarketDataPoint,
} from './market-data/market.data.guard.js';
export { FeedConsensus, type ConsensusResult } from './market-data/feed.consensus.js';
export { AnomalyFilter, type AnomalyFilterResult } from './market-data/anomaly.filter.js';
export {
  FeedSignatureVerifier,
  RawMarketDataPointSchema,
  type RawMarketDataPoint,
} from './market-data/feed.signature.verifier.js';
