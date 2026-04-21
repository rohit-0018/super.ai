# Security Module — `@super-ai/security`

Comprehensive security layer for the Super.AI autonomous trading agent platform. This module enforces defense-in-depth across every request, every LLM decision, and every trade action the agent produces.

**Package:** `@super-ai/security` v1.0.0
**Runtime:** Node.js >= 20
**Test framework:** Vitest 1.x
**Key dependencies:** Zod, jose, ioredis, otplib, @aws-sdk/client-kms

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Threat Model](#2-threat-model)
3. [Configuration Guide](#3-configuration-guide)
4. [Mounting the Middleware Stack](#4-mounting-the-middleware-stack)
5. [Registering Alert Consumers](#5-registering-alert-consumers)
6. [Forensics and Incident Investigation](#6-forensics-and-incident-investigation)
7. [Kill Switch Operations](#7-kill-switch-operations)
8. [Running the Test Suite](#8-running-the-test-suite)
9. [What This Module Does NOT Cover](#9-what-this-module-does-not-cover)

---

## 1. Architecture Overview

The security module implements a **layered defense-in-depth architecture**. Each layer operates independently so that a bypass of one layer does not compromise the others. Every layer emits structured `SecurityEvent` entries to the tamper-evident audit log and can trigger alerts through the `AlertBus`.

```
 Request
   |
   v
 +-----------------------+
 | Headers & CORS        |  security.headers, cors.middleware
 +-----------------------+
   |
   v
 +-----------------------+
 | Auth Layer            |  jwt.validator, session.binder, mfa.gate,
 |                       |  device.trust, token.rotator
 +-----------------------+
   |
   v
 +-----------------------+
 | Rate Limiting         |  rate.limiter, exchange.quota.adapter
 +-----------------------+
   |
   v
 +-----------------------+
 | Kill Switch Gate      |  kill.switch (GLOBAL / USER / STRATEGY)
 +-----------------------+
   |
   v
 +-----------------------+
 | Input Guards          |  pii.scrubber, injection.detector,
 |                       |  context.integrity, source.trust.classifier
 +-----------------------+
   |
   v
 +-----------------------+
 | Market Data Guards    |  feed.consensus, anomaly.filter,
 |                       |  feed.signature.verifier
 +-----------------------+
   |
   v
 +--- LLM / Agent Decision ---+
   |
   v
 +-----------------------+
 | Output Filters        |  action.allowlist, sanity.checker,
 |                       |  duplicate.detector
 +-----------------------+
   |
   v
 +-----------------------+
 | Risk Engine           |  circuit.breaker (velocity, error-rate, loss),
 |                       |  position.limits, loss.monitor, kill.switch
 +-----------------------+
   |
   v
 +-----------------------+
 | Confirmation Gate     |  confirmation.gate, approval.flow
 +-----------------------+
   |
   v
 +-----------------------+
 | Compliance            |  wash.trade.detector, layering.detector,
 |                       |  short.sell.control, trade.reporter
 +-----------------------+
   |
   v
 +-----------------------+
 | Anomaly Detection     |  anomaly.detector, strategy.drift.detector
 +-----------------------+
   |
   v
 +-----------------------+
 | Crypto / Signing      |  crypto.service (AES-256-GCM),
 |                       |  signing.service (Ed25519)
 +-----------------------+
   |
   v
 +-----------------------+
 | Audit                 |  audit.logger, hmac.chain, forensics.service
 +-----------------------+
   |
   v
 +-----------------------+
 | Secrets Management    |  secrets.loader, kms.adapter (AWS / local),
 |                       |  key.rotation.watcher, dead.mans.switch
 +-----------------------+
   |
   v
 +-----------------------+
 | Alert Bus             |  alert.bus -> webhook, slack, email, log
 +-----------------------+
```

### Layer Descriptions

#### Headers and CORS (`headers/`)

- **`security.headers.ts`** -- Sets `Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and `Permissions-Policy` headers. Adjusts strictness based on the `environment` setting (development, staging, production).
- **`cors.middleware.ts`** -- Enforces origin allowlists via `corsAllowedOrigins`. Rejects requests from unlisted origins in production.

#### Auth (`auth/`)

- **`jwt.validator.ts`** -- Validates JWTs using asymmetric keys (RS256/Ed25519) loaded from disk. Rejects expired, malformed, or tampered tokens. Exports `ValidatedToken` and `TokenPair` types.
- **`session.binder.ts`** -- Binds sessions to device fingerprints and IP addresses. Detects session hijacking by comparing `IncomingRequest` metadata against the `BoundSession` stored in Redis.
- **`mfa.gate.ts`** -- Enforces step-up MFA for actions at or above `mfaStepUpThresholdRiskLevel`. Uses TOTP via `otplib`. Challenges are stored in Redis with TTL.
- **`device.trust.ts`** -- Maintains a per-device trust score in Redis. Scores increment on successful auth (`deviceTrustScoreIncrement`) and are checked against `deviceTrustScoreThreshold`. Untrusted devices trigger MFA.
- **`token.rotator.ts`** -- Implements refresh token rotation. Each refresh token is single-use; reuse of a consumed token invalidates the entire session (replay attack detection).

#### Input Guards (`input/`)

- **`pii.scrubber.ts`** -- Detects and redacts PII (SSNs, emails, credit card numbers, phone numbers) from user input before it reaches the LLM. Configurable via `piiScrubbingPatterns`. Returns `ScrubResult` with detected `PiiType` entries.
- **`injection.detector.ts`** -- Scores input for prompt injection, jailbreak attempts, and system prompt extraction attacks. Blocks input above `injectionDetectionThresholdScore` (0-1 scale). Designed for adversarial LLM inputs.
- **`context.integrity.ts`** -- Seals the system prompt and context with an HMAC. Detects if the LLM's context window has been tampered with between turns. Returns `SealedContext`.
- **`source.trust.classifier.ts`** -- Classifies input sources as `INTERNAL`, `VERIFIED_EXTERNAL`, or `UNVERIFIED_EXTERNAL`. Unverified sources receive additional scrutiny from injection detection and rate limiting.

#### Market Data Guards (`market-data/`)

- **`feed.consensus.ts`** -- Requires multiple independent data feeds to agree within `feedConsensusDivergenceThresholdPercent` before accepting a price. Rejects outlier feeds.
- **`anomaly.filter.ts`** -- Flags price data points that deviate more than `anomalyStdDevMultiplier` standard deviations from a rolling window of `anomalyWindowSize` points.
- **`feed.signature.verifier.ts`** -- Verifies cryptographic signatures on market data payloads using provider public keys from `feedSignaturePublicKeys`. Rejects unsigned or tampered data.
- **`market.data.guard.ts`** -- Orchestrates all three sub-guards. Checks staleness against `marketDataStalenessThresholdMs`. Returns `ValidatedMarketDataPoint` only if consensus, anomaly, and signature checks all pass.

#### Output Filters (`output/`)

- **`action.allowlist.ts`** -- Maintains an allowlist of permitted `AgentActionType` values (`PLACE_ORDER`, `CANCEL_ORDER`, `MODIFY_ORDER`, `CLOSE_POSITION`, `REQUEST_HUMAN_REVIEW`, `NO_ACTION`). Blocks any action type not on the list.
- **`sanity.checker.ts`** -- Validates that proposed trades are within the `approvedTradingUniverse`, within `positionLimitsPerInstrument`, within `portfolioNotionalLimit`, and that the proposed price is reasonable relative to current market data.
- **`duplicate.detector.ts`** -- Uses Redis to detect duplicate orders within a time window. Prevents the LLM from accidentally submitting the same order twice.
- **`output.filter.ts`** -- Orchestrates the allowlist, sanity checker, and duplicate detector into a single `FilteredOutput` result.

#### Risk Engine (`risk/`)

- **`circuit.breaker.ts`** -- Implements the circuit breaker pattern with three states: `CLOSED` (normal), `OPEN` (tripped), `HALF_OPEN` (probing). Three instances are created by bootstrap:
  - **Velocity breaker** -- Trips when order count exceeds `velocityCircuitBreakerOrderCount` within `velocityCircuitBreakerWindowSeconds`.
  - **Error-rate breaker** -- Trips after `errorRateCircuitBreakerConsecutiveRejectionCount` consecutive rejected actions.
  - **Loss breaker** -- Trips on a single loss limit breach.
- **`kill.switch.ts`** -- Emergency halt with three scopes: `GLOBAL`, `USER` (by userId), and `STRATEGY` (by strategyId). State is stored in Redis. Only `adminUserId` can reset. Installs as Express middleware that returns `503 KILL_SWITCH_ACTIVE` when active.
- **`position.limits.ts`** -- Checks proposed orders against `positionLimitsPerInstrument` and `portfolioNotionalLimit`. Returns `LimitCheckResult` with any `LimitBreach` entries.
- **`loss.monitor.ts`** -- Tracks session P&L and high watermark drawdown. Triggers the kill switch when drawdown exceeds `sessionDrawdownKillSwitchPercent`.
- **`risk.engine.ts`** -- Facade that evaluates a `RiskContext` through all risk sub-systems (circuit breakers, kill switch, position limits, loss monitor). Returns a `RiskEvaluation` with an aggregate risk level.

#### Confirmation Gate (`confirmation/`)

- **`confirmation.gate.ts`** -- Determines whether an action requires human approval based on `highValueConfirmationThreshold` and risk level. Returns an `EnforcementResult`.
- **`approval.flow.ts`** -- Manages the approval lifecycle: challenge issuance, HMAC-signed approval tokens, expiry, ownership verification, and replay protection. Challenges are stored in Redis with TTL. Throws typed errors: `ConfirmationExpiredError`, `ConfirmationReplayError`, `ConfirmationOwnershipError`, `ConfirmationSignatureError`.

#### Compliance (`compliance/`)

- **`wash.trade.detector.ts`** -- Detects wash trading (simultaneous buy and sell of the same instrument by the same entity) within `washTradeDetectionWindowMs`.
- **`layering.detector.ts`** -- Detects layering/spoofing patterns by monitoring the cancel-to-order ratio within `layeringDetectionWindowMs`. Flags when the ratio exceeds `layeringCancelRatioThreshold`.
- **`short.sell.control.ts`** -- Blocks naked short sells based on account type (`AccountType`). Returns `ShortSellCheckResult`.
- **`trade.reporter.ts`** -- Reports executed trades to one or more adapters (`LocalJsonlTradeReporter` for local JSONL files, `WebhookTradeReporter` for external reporting endpoints).

#### Rate Limiting (`rate-limit/`)

- **`rate.limiter.ts`** -- Sliding window rate limiter backed by Redis. Supports per-user, per-strategy, per-instrument, and per-exchange tiers configured via `rateLimitUser`, `rateLimitStrategy`, `rateLimitInstrument`, `rateLimitExchange`.
- **`exchange.quota.adapter.ts`** -- Tracks exchange-specific API quotas. Prevents the platform from exceeding exchange rate limits and triggering bans.
- **`redis.adapter.ts`** -- Thin abstraction over ioredis exposing `get`, `set`, `del`, `incr`, `expire`, `healthCheck`, and sliding window operations.

#### Secrets Management (`secrets/`)

- **`secrets.loader.ts`** -- Loads secrets from KMS and provides a `get(name)` accessor. Emits `SECRET_LOADED` events.
- **`kms.adapter.ts`** -- Adapter interface (`KmsAdapter`) with two implementations:
  - `LocalKmsAdapter` -- For development; derives keys locally.
  - `AwsKmsAdapter` -- For production; uses AWS KMS for envelope encryption.
- **`key.rotation.watcher.ts`** -- Polls KMS at `secretsRotationPollIntervalSeconds` intervals to detect key version changes. Triggers secret reload on rotation.
- **`dead.mans.switch.ts`** -- Requires periodic heartbeats. If no heartbeat is received within `deadManSwitchHeartbeatTimeoutSeconds`, triggers the kill switch and emits a `DEAD_MANS_SWITCH_TRIGGERED` alert. Prevents orphaned agent processes from trading without oversight.

#### Audit (`audit/`)

- **`audit.logger.ts`** -- Appends structured `LogEntry` records to a JSONL file via `JsonlFileWriter`. Each entry includes `eventType`, `timestamp`, `correlationId`, `riskLevel`, `sessionId`, `resultStatus`, `payload`, and an HMAC hash.
- **`hmac.chain.ts`** -- Produces and verifies an HMAC chain (each entry's HMAC covers the previous entry's HMAC). Detects tampering, insertion, or deletion of log entries. Returns `ChainVerificationResult` with `valid`, `totalEntries`, and `firstInvalidIndex`.
- **`forensics.service.ts`** -- Replays a session by reading the audit log, filtering by `sessionId`, verifying the HMAC chain, and building a `SessionReplaySummary` (counts per event type, blocked actions, anomalies). Supports `exportSession()` to write formatted JSON.
- **`log.entry.schema.ts`** -- Zod schema for `LogEntry` with `ResultStatus` enum (`ALLOWED`, `BLOCKED`, `FLAGGED`, `ERROR`).

#### Anomaly Detection (`anomaly/`)

- **`anomaly.detector.ts`** -- Multi-signal anomaly detector covering:
  - **Velocity** -- More than `velocityMaxTradesPerMinute` trades triggers an alert.
  - **Value spikes** -- Trade notional exceeding `highValueSpikeMultiplier` times the rolling average.
  - **Geo-impossibility** -- Login from a location more than `geoImpossibilityMaxKm` away within `geoImpossibilityWindowMinutes` of the previous login.
  - **Device mismatch** -- Device fingerprint does not match the session's trusted device.
  - **Strategy drift** -- Delegates to `StrategyDriftDetector`.
- **`strategy.drift.detector.ts`** -- Maintains a `TradeProfile` per strategy in Redis (instrument distribution, side ratio, average size). Flags trades that deviate beyond `driftThreshold` from the historical profile.
- **`alert.bus.ts`** -- Pub/sub bus for security alerts. Accepts `AnomalyEvent` objects and fans them out to all registered `AlertConsumer` implementations:
  - `WebhookAlertConsumer` -- POST with HMAC signature.
  - `SlackAlertConsumer` -- Slack incoming webhook.
  - `EmailAlertConsumer` -- Sends via an injected `EmailTransport`.
  - `LogAlertConsumer` -- Writes to the application logger.

#### Crypto (`crypto/`)

- **`crypto.service.ts`** -- Field-level encryption using AES-256-GCM. Encrypts sensitive fields (API keys, secrets) at rest. Returns `EncryptedValue` objects containing ciphertext, IV, auth tag, and key ID.
- **`signing.service.ts`** -- Ed25519 digital signatures for audit entries and outbound actions. Ensures non-repudiation: every action the agent takes is cryptographically signed.

---

## 2. Threat Model

### System Context

Super.AI is an **autonomous AI trading agent**. An LLM receives market data, news feeds, social sentiment, and user instructions, then produces trading actions (place/cancel/modify orders) that are executed against real exchanges.

### Primary Threat Vectors

| Vector | Description |
|--------|-------------|
| **LLM as attacker** | The LLM itself is treated as a primary threat vector, equal in severity to an external attacker. It can be manipulated via prompt injection in any input channel. A compromised LLM can produce unlimited hostile actions. |
| **Market data feeds** | Compromised or spoofed price data can cause the agent to trade on false signals. |
| **News and social sentiment** | Fake news or manipulated social data can trigger trades. |
| **User messages** | Users (or attackers impersonating users) can inject prompts, attempt privilege escalation, or trigger wash trades. |
| **Cascading bad trades** | A single bad LLM decision can cascade into a sequence of losses. Without circuit breakers and kill switches, an agent can drain an account in seconds. |

### Design Principles

1. **Every input is hostile.** Market data, user messages, news feeds, and the LLM's own output are all untrusted by default.
2. **The LLM has zero implicit trust.** Its proposed actions pass through the same security pipeline as external requests.
3. **Fail closed.** If any security check cannot be performed (Redis down, KMS unavailable, feed stale), the system blocks the action rather than allowing it.
4. **Defense in depth.** No single layer is sufficient. Multiple independent layers must all agree before an action executes.
5. **Auditability.** Every decision, block, and approval is recorded in a tamper-evident HMAC-chained log that supports forensic replay.
6. **Human in the loop.** High-value and high-risk actions require explicit human approval through the confirmation gate.
7. **Automatic containment.** Circuit breakers, kill switches, loss monitors, and the dead man's switch provide automatic containment without human intervention.

### Attack Scenarios Addressed

- Prompt injection via user message causing the agent to dump all positions
- Spoofed price feed causing the agent to buy at an inflated price
- Session hijacking to issue trades under another user's account
- Replay attacks resubmitting a previously approved high-value trade
- Wash trading through LLM manipulation
- Layering/spoofing via rapid order-cancel sequences
- Agent process crash or hang with open positions (dead man's switch)
- Audit log tampering to cover tracks after a breach
- Key compromise with no rotation detection

---

## 3. Configuration Guide

All configuration is defined in the `SecurityConfig` type, validated at startup by the `SecurityConfigSchema` (Zod). The `bootstrapSecurity()` function rejects invalid configs with detailed error messages.

### Full Configuration Example

```typescript
import type { SecurityConfig } from '@super-ai/security';
import { RiskLevel } from '@super-ai/security';

const config: SecurityConfig = {
  // ── JWT / Auth ──────────────────────────────────────────────────────
  jwtPublicKeyPath: './keys/jwt-public.pem',
  jwtPrivateKeyPath: './keys/jwt-private.pem',
  accessTokenExpirySeconds: 900,           // 15 minutes
  refreshTokenExpirySeconds: 86400,        // 24 hours

  // ── MFA ─────────────────────────────────────────────────────────────
  mfaTotpIssuer: 'SuperAI',
  mfaStepUpThresholdRiskLevel: RiskLevel.HIGH,

  // ── Device Trust ────────────────────────────────────────────────────
  deviceTrustScoreThreshold: 70,           // 0-100 scale
  deviceTrustScoreIncrement: 5,            // +5 per successful auth

  // ── Market Data Feeds ───────────────────────────────────────────────
  marketDataStalenessThresholdMs: 5000,    // 5 seconds
  feedConsensusDivergenceThresholdPercent: 1.5,
  feedSignaturePublicKeys: {
    binance: '-----BEGIN PUBLIC KEY-----\nMIIB...\n-----END PUBLIC KEY-----',
    coinbase: '-----BEGIN PUBLIC KEY-----\nMIIB...\n-----END PUBLIC KEY-----',
  },

  // ── Anomaly Detection ──────────────────────────────────────────────
  anomalyStdDevMultiplier: 3,
  anomalyWindowSize: 100,

  // ── Input Validation / Injection ────────────────────────────────────
  injectionDetectionThresholdScore: 0.7,
  piiScrubbingPatterns: [
    '\\b\\d{3}-\\d{2}-\\d{4}\\b',                              // SSN
    '\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Z|a-z]{2,}\\b', // Email
    '\\b\\d{16}\\b',                                            // CC number
    '\\b\\d{4}[- ]?\\d{4}[- ]?\\d{4}[- ]?\\d{4}\\b',          // CC with separators
  ],

  // ── Trading Universe & Limits ───────────────────────────────────────
  approvedTradingUniverse: ['BTC-USD', 'ETH-USD', 'SOL-USD', 'AVAX-USD'],
  positionLimitsPerInstrument: {
    'BTC-USD': 10,       // max 10 BTC
    'ETH-USD': 100,      // max 100 ETH
    'SOL-USD': 5000,
    'AVAX-USD': 10000,
  },
  portfolioNotionalLimit: 1_000_000,       // $1M total notional cap
  sessionDrawdownKillSwitchPercent: 10,    // 10% drawdown triggers kill switch

  // ── Circuit Breakers ────────────────────────────────────────────────
  velocityCircuitBreakerOrderCount: 50,
  velocityCircuitBreakerWindowSeconds: 60,
  errorRateCircuitBreakerConsecutiveRejectionCount: 5,

  // ── Trading Hours ───────────────────────────────────────────────────
  tradingHoursPerMarket: {
    crypto: { open: '00:00', close: '23:59' },
    equities: { open: '09:30', close: '16:00' },
  },

  // ── Confirmations ──────────────────────────────────────────────────
  highValueConfirmationThreshold: 50_000,  // $50k requires human approval

  // ── Compliance ─────────────────────────────────────────────────────
  washTradeDetectionWindowMs: 1000,
  layeringDetectionWindowMs: 5000,
  layeringCancelRatioThreshold: 0.8,

  // ── Rate Limiting ──────────────────────────────────────────────────
  rateLimitUser: { requests: 100, windowMs: 60_000 },
  rateLimitStrategy: { requests: 50, windowMs: 60_000 },
  rateLimitInstrument: { requests: 200, windowMs: 60_000 },
  rateLimitExchange: { requests: 1000, windowMs: 60_000 },

  // ── Redis ──────────────────────────────────────────────────────────
  redisUrl: 'redis://localhost:6379',

  // ── KMS / Secrets ──────────────────────────────────────────────────
  kmsKeyArn: 'arn:aws:kms:us-east-1:123456789:key/abcd-1234',
  kmsProvider: 'aws',                      // 'local' for development
  secretsRotationPollIntervalSeconds: 300, // 5 minutes

  // ── Dead Man's Switch ──────────────────────────────────────────────
  deadManSwitchHeartbeatTimeoutSeconds: 120, // 2 minutes without heartbeat

  // ── Audit ──────────────────────────────────────────────────────────
  auditLogOutputPath: './logs/audit.jsonl',
  hmacChainSecret: 'a-random-string-of-at-least-32-characters-long!!',

  // ── CORS ───────────────────────────────────────────────────────────
  corsAllowedOrigins: ['https://app.super.ai', 'https://admin.super.ai'],

  // ── Alerts ─────────────────────────────────────────────────────────
  alertWebhookUrls: ['https://hooks.example.com/security'],
  alertSlackChannel: '#security-alerts',
  alertSlackWebhookUrl: 'https://hooks.slack.com/services/T00/B00/xxxx',

  // ── Feed Signatures ────────────────────────────────────────────────
  // (covered above in feedSignaturePublicKeys)

  // ── Encryption & Signing ───────────────────────────────────────────
  encryptionKeyId: 'default-enc-key',
  signingPrivateKey: '-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----',
  signingPublicKey: '-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----',

  // ── Admin ──────────────────────────────────────────────────────────
  adminUserId: 'admin-001',

  // ── Environment ────────────────────────────────────────────────────
  environment: 'production',
};
```

### Configuration Reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `jwtPublicKeyPath` | `string` | (required) | File path to the JWT public key (PEM or JWK) |
| `jwtPrivateKeyPath` | `string` | (required) | File path to the JWT private key (PEM or JWK) |
| `accessTokenExpirySeconds` | `number` | `900` | Access token TTL in seconds |
| `refreshTokenExpirySeconds` | `number` | `86400` | Refresh token TTL in seconds |
| `mfaTotpIssuer` | `string` | `'SuperAI'` | TOTP issuer name shown in authenticator apps |
| `mfaStepUpThresholdRiskLevel` | `RiskLevel` | `HIGH` | Minimum risk level that triggers step-up MFA |
| `deviceTrustScoreThreshold` | `number` | `70` | Minimum device trust score (0-100) |
| `deviceTrustScoreIncrement` | `number` | `5` | Trust score increment per successful auth |
| `marketDataStalenessThresholdMs` | `number` | `5000` | Maximum data age in ms before considered stale |
| `feedConsensusDivergenceThresholdPercent` | `number` | `1.5` | Maximum feed divergence percentage |
| `feedSignaturePublicKeys` | `Record<string, string>` | `{}` | Map of feed provider ID to Ed25519/RSA public key |
| `anomalyStdDevMultiplier` | `number` | `3` | Std dev multiplier for anomaly flagging |
| `anomalyWindowSize` | `number` | `100` | Rolling window size for anomaly detection |
| `injectionDetectionThresholdScore` | `number` | `0.7` | Injection detection confidence threshold (0-1) |
| `piiScrubbingPatterns` | `string[]` | SSN, email, CC patterns | Regex patterns for PII detection |
| `approvedTradingUniverse` | `string[]` | `[]` | Whitelist of allowed instrument symbols |
| `positionLimitsPerInstrument` | `Record<string, number>` | `{}` | Max position size per instrument |
| `portfolioNotionalLimit` | `number` | `1,000,000` | Max total portfolio notional value |
| `sessionDrawdownKillSwitchPercent` | `number` | `10` | Drawdown % that triggers the kill switch |
| `velocityCircuitBreakerOrderCount` | `number` | `50` | Orders in window that trip velocity breaker |
| `velocityCircuitBreakerWindowSeconds` | `number` | `60` | Velocity breaker time window |
| `errorRateCircuitBreakerConsecutiveRejectionCount` | `number` | `5` | Consecutive rejections before error breaker opens |
| `tradingHoursPerMarket` | `Record<string, {open, close}>` | crypto 00:00-23:59 | Trading hours per market (HH:MM UTC) |
| `highValueConfirmationThreshold` | `number` | `50,000` | Notional value requiring human confirmation |
| `washTradeDetectionWindowMs` | `number` | `1000` | Wash trade detection time window |
| `layeringDetectionWindowMs` | `number` | `5000` | Layering detection time window |
| `layeringCancelRatioThreshold` | `number` | `0.8` | Cancel-to-order ratio threshold for layering |
| `rateLimitUser` | `{requests, windowMs}` | 100/60s | Per-user rate limit |
| `rateLimitStrategy` | `{requests, windowMs}` | 50/60s | Per-strategy rate limit |
| `rateLimitInstrument` | `{requests, windowMs}` | 200/60s | Per-instrument rate limit |
| `rateLimitExchange` | `{requests, windowMs}` | 1000/60s | Per-exchange rate limit |
| `redisUrl` | `string` | `redis://localhost:6379` | Redis connection URL |
| `kmsKeyArn` | `string` | `''` | AWS KMS key ARN |
| `kmsProvider` | `'local' \| 'aws'` | `'local'` | KMS provider selection |
| `secretsRotationPollIntervalSeconds` | `number` | `300` | Secrets rotation polling interval |
| `deadManSwitchHeartbeatTimeoutSeconds` | `number` | `120` | Heartbeat timeout before kill switch triggers |
| `auditLogOutputPath` | `string` | `./logs/audit.jsonl` | Path for HMAC-chained audit log |
| `hmacChainSecret` | `string` | (required, min 32 chars) | HMAC secret for audit chain integrity |
| `corsAllowedOrigins` | `string[]` | `['http://localhost:3001']` | Allowed CORS origins |
| `alertWebhookUrls` | `string[]` | `[]` | Webhook URLs for alerts |
| `alertSlackChannel` | `string` | `'#security-alerts'` | Slack channel for alerts |
| `alertSlackWebhookUrl` | `string?` | (optional) | Slack webhook URL |
| `encryptionKeyId` | `string` | `'default-enc-key'` | Key ID for field-level encryption |
| `signingPrivateKey` | `string` | (required) | PEM private key for signing |
| `signingPublicKey` | `string` | (required) | PEM public key for verification |
| `adminUserId` | `string` | (required) | Admin user ID for kill switch reset |
| `environment` | `'development' \| 'staging' \| 'production'` | `'development'` | Deployment environment |

---

## 4. Mounting the Middleware Stack

The `bootstrapSecurity()` function wires every sub-module together and returns a `SecurityMiddlewareStack` containing:

- `middleware` -- An ordered array of Express `RequestHandler` functions to mount on your app.
- Service references for application-level use (kill switch, risk engine, alert bus, forensics, etc.).

### Basic Setup

```typescript
import express from 'express';
import { bootstrapSecurity } from '@super-ai/security';
import type { SecurityConfig } from '@super-ai/security';

const app = express();

const config: SecurityConfig = {
  // ... your config (see section 3)
};

async function main() {
  const security = await bootstrapSecurity(config);

  // Mount the security middleware stack.
  // Order matters: CORS -> Security Headers -> Kill Switch Gate
  for (const mw of security.middleware) {
    app.use(mw);
  }

  // The returned object gives you direct access to all services:
  //   security.killSwitch
  //   security.alertBus
  //   security.riskEngine
  //   security.auditLogger
  //   security.forensicsService
  //   security.inputGuard
  //   security.outputFilter
  //   security.confirmationGate
  //   security.marketDataGuard
  //   security.anomalyDetector
  //   security.cryptoService
  //   security.signingService
  //   security.rateLimiter
  //   security.complianceServices.washTradeDetector
  //   security.complianceServices.layeringDetector
  //   security.complianceServices.shortSellControl
  //   security.complianceServices.tradeReporter

  app.listen(3001, () => {
    console.log('Server running with security middleware');
  });
}

main().catch(console.error);
```

### What the Middleware Array Contains (in order)

1. **CORS middleware** -- Based on `corsAllowedOrigins` and `environment`.
2. **Security headers** -- CSP, HSTS, X-Frame-Options, etc.
3. **Kill switch middleware** -- Returns `503` if a GLOBAL, USER, or STRATEGY kill switch is active. Reads `x-user-id` and `x-strategy-id` from request headers to check scoped switches.

### Using Services in Route Handlers

```typescript
app.post('/api/trade', async (req, res) => {
  // 1. Sanitize input
  const sanitized = await security.inputGuard.sanitize({
    text: req.body.userMessage,
    source: 'user',
  });

  // 2. Validate market data
  const validatedData = await security.marketDataGuard.validate(rawMarketData);

  // 3. [LLM produces an action here]

  // 4. Filter the action through output guards
  const filtered = await security.outputFilter.filter(proposedAction);
  if (!filtered.allowed) {
    return res.status(403).json({ error: filtered.reason });
  }

  // 5. Evaluate risk
  const riskEval = await security.riskEngine.evaluate(riskContext);
  if (riskEval.blocked) {
    return res.status(403).json({ error: riskEval.reason });
  }

  // 6. Check if confirmation is needed
  const enforcement = await security.confirmationGate.enforce(action);
  if (enforcement.requiresConfirmation) {
    return res.status(202).json({ challenge: enforcement.challenge });
  }

  // 7. Compliance checks
  const washCheck = await security.complianceServices.washTradeDetector.check(trade);
  const layeringCheck = await security.complianceServices.layeringDetector.check(orders);

  // 8. Execute trade (application layer -- not covered by this module)
  // ...

  // 9. Report trade
  await security.complianceServices.tradeReporter.report(executedTrade);
});
```

---

## 5. Registering Alert Consumers

The `AlertBus` fans out security alerts to all registered consumers. Bootstrap registers `WebhookAlertConsumer`, `SlackAlertConsumer`, and `LogAlertConsumer` automatically based on config. You can register additional consumers at runtime.

### Built-in Consumers

| Consumer | Trigger | Config |
|----------|---------|--------|
| `WebhookAlertConsumer` | POST with HMAC-signed body | `alertWebhookUrls` |
| `SlackAlertConsumer` | Slack incoming webhook | `alertSlackWebhookUrl` |
| `EmailAlertConsumer` | Sends via injected `EmailTransport` | Manual registration |
| `LogAlertConsumer` | Writes to application logger | Always registered |

### Registering an Email Consumer

```typescript
import { EmailAlertConsumer } from '@super-ai/security';
import type { EmailTransport } from '@super-ai/security';

const emailTransport: EmailTransport = {
  async send(to: string, subject: string, body: string): Promise<void> {
    // Use your email service (SendGrid, SES, etc.)
    await sendgrid.send({ to, subject, html: body });
  },
};

const emailConsumer = new EmailAlertConsumer(
  'security-team@company.com',
  emailTransport,
);

security.alertBus.register(emailConsumer);
```

### Registering a Custom Consumer

Implement the `AlertConsumer` interface:

```typescript
import type { AlertConsumer, AnomalyEvent } from '@super-ai/security';

class PagerDutyAlertConsumer implements AlertConsumer {
  async consume(event: AnomalyEvent): Promise<void> {
    // Only escalate CRITICAL events to PagerDuty
    if (event.riskLevel === 'CRITICAL') {
      await this.pagerDutyClient.trigger({
        summary: event.description,
        severity: 'critical',
        source: 'super-ai-security',
      });
    }
  }
}

security.alertBus.register(new PagerDutyAlertConsumer());
```

### Alert Event Shape

Every alert emitted through the `AlertBus` has the `AnomalyEvent` shape:

```typescript
interface AnomalyEvent {
  eventType: string;        // SecurityEventType value
  riskLevel: string;        // RiskLevel value
  description: string;      // Human-readable description
  payload: Record<string, unknown>;
  timestamp: string;        // ISO-8601
}
```

---

## 6. Forensics and Incident Investigation

The `ForensicsService` provides session replay and export capabilities for post-incident investigation. It reads the HMAC-chained audit log, filters by session, and verifies chain integrity.

### Replaying a Session

```typescript
const replay = await security.forensicsService.replay('session-abc-123');

console.log(replay.sessionId);       // 'session-abc-123'
console.log(replay.chainValid);      // true if HMAC chain is intact
console.log(replay.entries.length);   // number of log entries in session
console.log(replay.summary);
// {
//   countsPerEventType: { ACTION_ALLOWED: 12, ACTION_BLOCKED: 3, ... },
//   firstTimestamp: '2026-04-12T10:00:00.000Z',
//   lastTimestamp: '2026-04-12T10:45:00.000Z',
//   totalActions: 15,
//   blockedActions: 3,
//   anomaliesDetected: 1,
// }
```

### Exporting a Session for External Analysis

```typescript
await security.forensicsService.exportSession(
  'session-abc-123',
  './exports/incident-2026-04-12.json',
);
```

This writes a formatted JSON file containing the full `SessionReplay` object.

### What the Replay Contains

- **`entries`** -- All `LogEntry` records for the session, sorted chronologically. Each entry includes:
  - `eventType` -- The `SecurityEventType` (e.g., `ACTION_ALLOWED`, `INJECTION_DETECTED`, `KILL_SWITCH_TRIGGERED`)
  - `timestamp` -- ISO-8601
  - `correlationId` -- UUID linking related events
  - `riskLevel` -- `LOW`, `MEDIUM`, `HIGH`, or `CRITICAL`
  - `sessionId` -- The session being replayed
  - `resultStatus` -- `ALLOWED`, `BLOCKED`, `FLAGGED`, or `ERROR`
  - `payload` -- Event-specific data
  - `hmac` -- HMAC hash for tamper detection
- **`chainValid`** -- Whether the HMAC chain for this session's entries is intact. If `false`, the audit log has been tampered with.
- **`summary`** -- Aggregate counts, timestamps, and anomaly tallies.

### HMAC Chain Verification (Standalone)

You can also verify the full audit log chain outside of a session replay:

```typescript
import { HmacChain } from '@super-ai/security';

const hmacChain = new HmacChain('your-hmac-secret-min-32-chars!!!!!');
const result = hmacChain.verifyChain(logEntries);

if (!result.valid) {
  console.error(`Chain broken at index ${result.firstInvalidIndex} of ${result.totalEntries}`);
}
```

---

## 7. Kill Switch Operations

The kill switch is an emergency mechanism that immediately halts all trading. It operates at three scopes and persists state in Redis.

### Scopes

| Scope | Effect | Redis Key |
|-------|--------|-----------|
| `GLOBAL` | Halts all trading for all users and strategies | `killswitch:global` |
| `USER` | Halts trading for a specific user | `killswitch:user:{userId}` |
| `STRATEGY` | Halts trading for a specific strategy | `killswitch:strategy:{strategyId}` |

The kill switch middleware checks scopes in order: GLOBAL first, then USER (from `x-user-id` header), then STRATEGY (from `x-strategy-id` header). If any scope is active, the request receives a `503` response with `KILL_SWITCH_ACTIVE`.

### Triggering the Kill Switch

```typescript
// Global halt -- stops everything
await security.killSwitch.trigger(
  { type: 'GLOBAL' },
  'Suspicious activity detected across multiple strategies',
  'loss-monitor',     // triggeredBy: who/what triggered it
);

// User-scoped halt
await security.killSwitch.trigger(
  { type: 'USER', userId: 'user-42' },
  'User exceeded session drawdown limit',
  'loss-monitor',
);

// Strategy-scoped halt
await security.killSwitch.trigger(
  { type: 'STRATEGY', strategyId: 'strat-momentum-btc' },
  'Strategy drift detected beyond threshold',
  'anomaly-detector',
);
```

### Checking Kill Switch Status

```typescript
const isGlobalActive = await security.killSwitch.isActive({ type: 'GLOBAL' });
const isUserHalted = await security.killSwitch.isActive({ type: 'USER', userId: 'user-42' });
const isStratHalted = await security.killSwitch.isActive({ type: 'STRATEGY', strategyId: 'strat-momentum-btc' });
```

Note: `isActive()` for any scope also checks the GLOBAL scope first. If GLOBAL is active, all scopes return `true`.

### Resetting the Kill Switch

Only the configured `adminUserId` can reset the kill switch. Unauthorized reset attempts throw an error.

```typescript
// Reset global kill switch (must be called by adminUserId)
await security.killSwitch.reset(
  { type: 'GLOBAL' },
  'admin-001',       // must match config.adminUserId
);

// Reset user-scoped kill switch
await security.killSwitch.reset(
  { type: 'USER', userId: 'user-42' },
  'admin-001',
);

// Reset strategy-scoped kill switch
await security.killSwitch.reset(
  { type: 'STRATEGY', strategyId: 'strat-momentum-btc' },
  'admin-001',
);
```

### Automatic Triggers

The kill switch is triggered automatically by:

1. **Loss Monitor** -- When session drawdown exceeds `sessionDrawdownKillSwitchPercent`.
2. **Dead Man's Switch** -- When no heartbeat is received within `deadManSwitchHeartbeatTimeoutSeconds`.
3. **Application code** -- Any service can call `killSwitch.trigger()` directly.

All triggers emit a `KILL_SWITCH_TRIGGERED` alert through the `AlertBus` at `CRITICAL` risk level.

---

## 8. Running the Test Suite

The module uses Vitest with Node environment. Every source file has a corresponding `.test.ts` file.

### Commands

```bash
# Run all tests once
npm test
# or
npx vitest run

# Run tests in watch mode (re-runs on file change)
npm run test:watch
# or
npx vitest

# Run tests with coverage report
npm run test:coverage
# or
npx vitest run --coverage

# Run a specific test file
npx vitest run risk/kill.switch.test.ts

# Run tests matching a pattern
npx vitest run --grep "circuit breaker"

# Type-check without emitting
npm run typecheck
```

### Test Configuration

The Vitest configuration is in `vitest.config.ts`:

- **Environment:** `node`
- **Globals:** enabled (no need to import `describe`, `it`, `expect`)
- **Test timeout:** 10,000 ms
- **Coverage provider:** V8
- **Coverage reporters:** `text` (terminal) and `lcov` (for CI integration)
- **Coverage excludes:** `node_modules/`, `dist/`, `*.test.ts`, `vitest.config.ts`

### Test File Layout

```
security/
  anomaly/
    alert.bus.test.ts
    anomaly.detector.test.ts
    strategy.drift.detector.test.ts
  audit/
    audit.logger.test.ts
    forensics.service.test.ts
    hmac.chain.test.ts
  auth/
    device.trust.test.ts
    jwt.validator.test.ts
    mfa.gate.test.ts
    session.binder.test.ts
    token.rotator.test.ts
  compliance/
    layering.detector.test.ts
    short.sell.control.test.ts
    trade.reporter.test.ts
    wash.trade.detector.test.ts
  confirmation/
    approval.flow.test.ts
    confirmation.gate.test.ts
  crypto/
    crypto.service.test.ts
    signing.service.test.ts
  headers/
    cors.middleware.test.ts
    security.headers.test.ts
  input/
    context.integrity.test.ts
    injection.detector.test.ts
    input.guard.test.ts
    pii.scrubber.test.ts
    source.trust.classifier.test.ts
  market-data/
    anomaly.filter.test.ts
    feed.consensus.test.ts
    feed.signature.verifier.test.ts
    market.data.guard.test.ts
  output/
    action.allowlist.test.ts
    duplicate.detector.test.ts
    output.filter.test.ts
    sanity.checker.test.ts
  rate-limit/
    exchange.quota.adapter.test.ts
    rate.limiter.test.ts
    redis.adapter.test.ts
  risk/
    circuit.breaker.test.ts
    kill.switch.test.ts
    loss.monitor.test.ts
    position.limits.test.ts
    risk.engine.test.ts
  secrets/
    dead.mans.switch.test.ts
    key.rotation.watcher.test.ts
    kms.adapter.test.ts
    secrets.loader.test.ts
```

### Writing New Tests

Tests should mock external dependencies (Redis, KMS, file system) and focus on the security invariants:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { KillSwitch } from './kill.switch.js';

describe('KillSwitch', () => {
  it('should block requests when GLOBAL switch is active', async () => {
    const mockRedis = {
      get: vi.fn().mockResolvedValue(JSON.stringify({ active: true, reason: 'test' })),
      set: vi.fn(),
      del: vi.fn(),
    };
    // ... test setup and assertions
  });
});
```

---

## 9. What This Module Does NOT Cover

This module is the security and risk management layer only. The following concerns are the responsibility of the application layer:

| Responsibility | Why It Is Excluded |
|---|---|
| **Actual order execution** | This module validates, filters, and gates orders. It does not submit them to exchanges. |
| **Exchange connectivity** | WebSocket/REST connections to exchanges (Binance, Coinbase, etc.) are managed by the execution layer. |
| **Portfolio state management** | Current positions, balances, and P&L tracking must be provided to the risk engine by the application. |
| **User management and registration** | User CRUD, onboarding, KYC. This module validates JWT tokens but does not issue them at registration. |
| **UI / frontend** | All frontend concerns including the confirmation approval UI. |
| **Notification delivery beyond webhooks** | Push notifications, SMS, in-app notifications. This module provides webhook, Slack, email, and log consumers. Delivery infrastructure is external. |
| **Database persistence** | This module uses Redis for ephemeral state (sessions, rate limits, circuit breakers). Persistent storage of trade history, user data, etc. is application-level. |
| **Deployment and infrastructure** | Docker, Kubernetes, load balancers, TLS termination, cloud provider configuration. |
| **Horizontal scaling of Redis** | This module connects to a single Redis URL. Redis Cluster, Sentinel, or replication topology is an infrastructure concern. |
| **Actual MFA device enrollment** | This module verifies TOTP codes. The enrollment flow (QR code generation, backup codes) is application-level. The `MfaGate` expects a `getTotpSecret(userId)` callback. |
| **Actual geo-IP resolution** | The anomaly detector accepts a `GeoIpAdapter` interface. Bootstrap provides a no-op adapter. The application must inject a real implementation (e.g., MaxMind GeoIP2). |
| **LLM provider integration** | Calling OpenAI/Anthropic/etc. APIs. This module guards the LLM's inputs and outputs but does not manage the LLM connection. |
| **Strategy logic** | Trading strategy implementation. This module monitors strategy drift but does not implement strategies. |

---

## Module File Map

```
security/
  index.ts                          Public API re-exports
  bootstrap.ts                      bootstrapSecurity() wiring
  package.json                      @super-ai/security
  tsconfig.json                     TypeScript configuration
  vitest.config.ts                  Test configuration
  types/
    config.ts                       SecurityConfig + SecurityConfigSchema (Zod)
    events.ts                       SecurityEventType, RiskLevel, SourceTrust, event schemas
    errors.ts                       SecurityError hierarchy (16 error classes)
    actions.ts                      AgentActionType, AgentAction union type
    risk.ts                         CircuitBreakerState, snapshot types
  auth/
    jwt.validator.ts                JWT validation (RS256/Ed25519)
    session.binder.ts               Session-to-device binding
    mfa.gate.ts                     Step-up MFA (TOTP)
    device.trust.ts                 Device trust scoring
    token.rotator.ts                Refresh token rotation
  input/
    input.guard.ts                  Input guard orchestrator
    pii.scrubber.ts                 PII detection and redaction
    injection.detector.ts           Prompt injection scoring
    context.integrity.ts            HMAC-sealed context
    source.trust.classifier.ts      Source trust classification
  market-data/
    market.data.guard.ts            Market data guard orchestrator
    feed.consensus.ts               Multi-feed consensus
    anomaly.filter.ts               Statistical anomaly filter
    feed.signature.verifier.ts      Feed signature verification
  output/
    output.filter.ts                Output filter orchestrator
    action.allowlist.ts             Action type allowlist
    sanity.checker.ts               Trade sanity checks
    duplicate.detector.ts           Duplicate order detection
  risk/
    risk.engine.ts                  Risk engine facade
    circuit.breaker.ts              Circuit breaker (3-state)
    kill.switch.ts                  Emergency kill switch
    position.limits.ts              Position limit checker
    loss.monitor.ts                 Drawdown and loss tracking
  confirmation/
    confirmation.gate.ts            Confirmation requirement check
    approval.flow.ts                Approval lifecycle management
  compliance/
    wash.trade.detector.ts          Wash trade detection
    layering.detector.ts            Layering/spoofing detection
    short.sell.control.ts           Short sell restrictions
    trade.reporter.ts               Trade reporting adapters
  rate-limit/
    rate.limiter.ts                 Sliding window rate limiter
    exchange.quota.adapter.ts       Exchange API quota tracking
    redis.adapter.ts                Redis abstraction layer
  secrets/
    secrets.loader.ts               Secret loading from KMS
    kms.adapter.ts                  KMS adapter (Local / AWS)
    key.rotation.watcher.ts         Key rotation polling
    dead.mans.switch.ts             Heartbeat-based kill switch
  anomaly/
    anomaly.detector.ts             Multi-signal anomaly detection
    strategy.drift.detector.ts      Strategy behavior drift
    alert.bus.ts                    Alert pub/sub with consumers
  audit/
    audit.logger.ts                 HMAC-chained JSONL logger
    hmac.chain.ts                   HMAC chain computation and verification
    forensics.service.ts            Session replay and export
    log.entry.schema.ts             LogEntry Zod schema
  crypto/
    crypto.service.ts               AES-256-GCM field encryption
    signing.service.ts              Ed25519 signing
  headers/
    security.headers.ts             HTTP security headers
    cors.middleware.ts              CORS middleware
```
