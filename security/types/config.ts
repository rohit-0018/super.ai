import { z } from 'zod';
import { RiskLevel } from './events.js';

// ─── Sub-schemas ─────────────────────────────────────────────────────────────

const TradingHoursSchema = z.object({
  open: z.string().regex(/^\d{2}:\d{2}$/).describe('Market open time in HH:MM UTC format'),
  close: z.string().regex(/^\d{2}:\d{2}$/).describe('Market close time in HH:MM UTC format'),
});

const RateLimitTierSchema = z.object({
  requests: z.number().int().positive().describe('Maximum number of requests allowed in the window'),
  windowMs: z.number().int().positive().describe('Time window in milliseconds'),
});

// ─── Security Config Schema ──────────────────────────────────────────────────

export const SecurityConfigSchema = z.object({
  // ── JWT / Auth ──────────────────────────────────────────────────────────
  jwtPublicKeyPath: z.string().min(1)
    .describe('File path to the JWT public key (PEM or JWK)'),
  jwtPrivateKeyPath: z.string().min(1)
    .describe('File path to the JWT private key (PEM or JWK)'),
  accessTokenExpirySeconds: z.number().int().positive().default(900)
    .describe('Access token TTL in seconds'),
  refreshTokenExpirySeconds: z.number().int().positive().default(86400)
    .describe('Refresh token TTL in seconds'),

  // ── MFA ─────────────────────────────────────────────────────────────────
  mfaTotpIssuer: z.string().min(1).default('SuperAI')
    .describe('TOTP issuer name shown in authenticator apps'),
  mfaStepUpThresholdRiskLevel: z.nativeEnum(RiskLevel).default(RiskLevel.HIGH)
    .describe('Minimum risk level that triggers step-up MFA'),

  // ── Device Trust ────────────────────────────────────────────────────────
  deviceTrustScoreThreshold: z.number().min(0).max(100).default(70)
    .describe('Minimum device trust score to grant access (0-100)'),
  deviceTrustScoreIncrement: z.number().min(0).max(100).default(5)
    .describe('Trust score increment per successful authentication from a device'),

  // ── Market Data Feeds ───────────────────────────────────────────────────
  marketDataStalenessThresholdMs: z.number().int().positive().default(5000)
    .describe('Maximum age in ms before market data is considered stale'),
  feedConsensusDivergenceThresholdPercent: z.number().min(0).max(100).default(1.5)
    .describe('Maximum allowed percentage divergence between feed sources'),
  feedSignaturePublicKeys: z.record(z.string(), z.string()).default({})
    .describe('Map of feed provider ID to its Ed25519/RSA public key (PEM)'),

  // ── Anomaly Detection ──────────────────────────────────────────────────
  anomalyStdDevMultiplier: z.number().positive().default(3)
    .describe('Number of standard deviations from mean to flag as anomaly'),
  anomalyWindowSize: z.number().int().positive().default(100)
    .describe('Rolling window size (number of data points) for anomaly detection'),

  // ── Input Validation / Injection ────────────────────────────────────────
  injectionDetectionThresholdScore: z.number().min(0).max(1).default(0.7)
    .describe('Confidence score threshold (0-1) above which input is flagged as injection'),
  piiScrubbingPatterns: z.array(z.string()).default([
    '\\b\\d{3}-\\d{2}-\\d{4}\\b',
    '\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Z|a-z]{2,}\\b',
    '\\b\\d{16}\\b',
    '\\b\\d{4}[- ]?\\d{4}[- ]?\\d{4}[- ]?\\d{4}\\b',
  ]).describe('Array of regex patterns for PII detection and scrubbing'),

  // ── Trading Universe & Limits ───────────────────────────────────────────
  approvedTradingUniverse: z.array(z.string().min(1)).default([])
    .describe('Whitelist of instrument symbols allowed for trading'),
  positionLimitsPerInstrument: z.record(z.string(), z.number().positive()).default({})
    .describe('Maximum position size per instrument (in base units)'),
  portfolioNotionalLimit: z.number().positive().default(1_000_000)
    .describe('Maximum total portfolio notional value in quote currency'),
  sessionDrawdownKillSwitchPercent: z.number().min(0).max(100).default(10)
    .describe('Drawdown percentage from high watermark that triggers the kill switch'),

  // ── Circuit Breakers ────────────────────────────────────────────────────
  velocityCircuitBreakerOrderCount: z.number().int().positive().default(50)
    .describe('Number of orders in the time window that trips the velocity breaker'),
  velocityCircuitBreakerWindowSeconds: z.number().int().positive().default(60)
    .describe('Time window in seconds for the velocity circuit breaker'),
  errorRateCircuitBreakerConsecutiveRejectionCount: z.number().int().positive().default(5)
    .describe('Consecutive rejected actions before the error-rate breaker opens'),

  // ── Trading Hours ───────────────────────────────────────────────────────
  tradingHoursPerMarket: z.record(z.string(), TradingHoursSchema).default({
    'crypto': { open: '00:00', close: '23:59' },
  }).describe('Trading hours per market identifier (market -> {open, close} in HH:MM UTC)'),

  // ── Confirmations ──────────────────────────────────────────────────────
  highValueConfirmationThreshold: z.number().positive().default(50_000)
    .describe('Notional value above which human confirmation is required'),

  // ── Compliance ─────────────────────────────────────────────────────────
  washTradeDetectionWindowMs: z.number().int().positive().default(1000)
    .describe('Time window in ms for detecting wash trades'),
  layeringDetectionWindowMs: z.number().int().positive().default(5000)
    .describe('Time window in ms for detecting layering/spoofing patterns'),
  layeringCancelRatioThreshold: z.number().min(0).max(1).default(0.8)
    .describe('Cancel-to-order ratio threshold above which layering is flagged'),

  // ── Rate Limiting ──────────────────────────────────────────────────────
  rateLimitUser: RateLimitTierSchema.default({ requests: 100, windowMs: 60_000 })
    .describe('Rate limit per user'),
  rateLimitStrategy: RateLimitTierSchema.default({ requests: 50, windowMs: 60_000 })
    .describe('Rate limit per strategy'),
  rateLimitInstrument: RateLimitTierSchema.default({ requests: 200, windowMs: 60_000 })
    .describe('Rate limit per instrument'),
  rateLimitExchange: RateLimitTierSchema.default({ requests: 1000, windowMs: 60_000 })
    .describe('Rate limit per exchange connection'),

  // ── Redis ──────────────────────────────────────────────────────────────
  redisUrl: z.string().url().default('redis://localhost:6379')
    .describe('Redis connection URL for session store and rate limiting'),

  // ── KMS / Secrets ──────────────────────────────────────────────────────
  kmsKeyArn: z.string().default('')
    .describe('AWS KMS key ARN for envelope encryption'),
  kmsProvider: z.enum(['local', 'aws']).default('local')
    .describe('KMS provider: "local" for dev, "aws" for production'),
  secretsRotationPollIntervalSeconds: z.number().int().positive().default(300)
    .describe('Interval in seconds for polling secrets rotation status'),

  // ── Dead Man Switch ────────────────────────────────────────────────────
  deadManSwitchHeartbeatTimeoutSeconds: z.number().int().positive().default(120)
    .describe('Seconds without a heartbeat before the dead man switch triggers'),

  // ── Audit ──────────────────────────────────────────────────────────────
  auditLogOutputPath: z.string().min(1).default('./logs/audit.jsonl')
    .describe('File path for the append-only HMAC-chained audit log'),
  hmacChainSecret: z.string().min(32)
    .describe('HMAC secret for audit log chain integrity (min 32 chars)'),

  // ── CORS ───────────────────────────────────────────────────────────────
  corsAllowedOrigins: z.array(z.string().url()).default(['http://localhost:3001'])
    .describe('Array of allowed CORS origins'),

  // ── Alerts ─────────────────────────────────────────────────────────────
  alertWebhookUrls: z.array(z.string().url()).default([])
    .describe('Webhook URLs for security alert notifications'),
  alertSlackChannel: z.string().default('#security-alerts')
    .describe('Slack channel name for security alerts'),
  alertSlackWebhookUrl: z.string().url().optional()
    .describe('Slack incoming webhook URL for alert delivery'),

  // ── Encryption & Signing ───────────────────────────────────────────────
  encryptionKeyId: z.string().min(1).default('default-enc-key')
    .describe('Key ID for field-level encryption'),
  signingPrivateKey: z.string().min(1)
    .describe('PEM-encoded private key for signing audit entries and actions'),
  signingPublicKey: z.string().min(1)
    .describe('PEM-encoded public key for verifying signatures'),

  // ── Admin ──────────────────────────────────────────────────────────────
  adminUserId: z.string().min(1)
    .describe('User ID of the platform administrator for kill switch reset and confirmations'),

  // ── Environment ────────────────────────────────────────────────────────
  environment: z.enum(['development', 'staging', 'production']).default('development')
    .describe('Deployment environment'),
});

// ─── Inferred type ───────────────────────────────────────────────────────────

export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;
