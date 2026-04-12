import { RiskLevel } from './events.js';

// ─── Error Code Enum ─────────────────────────────────────────────────────────

export enum SecurityErrorCode {
  // Auth
  AUTH_TOKEN_EXPIRED = 'AUTH_TOKEN_EXPIRED',
  AUTH_TOKEN_INVALID = 'AUTH_TOKEN_INVALID',
  AUTH_TOKEN_MISSING = 'AUTH_TOKEN_MISSING',
  AUTH_CREDENTIALS_INVALID = 'AUTH_CREDENTIALS_INVALID',
  AUTH_ACCOUNT_LOCKED = 'AUTH_ACCOUNT_LOCKED',

  // Authorization
  AUTHZ_INSUFFICIENT_PERMISSIONS = 'AUTHZ_INSUFFICIENT_PERMISSIONS',
  AUTHZ_ROLE_MISMATCH = 'AUTHZ_ROLE_MISMATCH',
  AUTHZ_RESOURCE_FORBIDDEN = 'AUTHZ_RESOURCE_FORBIDDEN',

  // Session
  SESSION_EXPIRED = 'SESSION_EXPIRED',
  SESSION_MISMATCH = 'SESSION_MISMATCH',
  SESSION_HIJACK_DETECTED = 'SESSION_HIJACK_DETECTED',
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',

  // MFA
  MFA_REQUIRED = 'MFA_REQUIRED',
  MFA_CODE_INVALID = 'MFA_CODE_INVALID',
  MFA_CODE_EXPIRED = 'MFA_CODE_EXPIRED',
  MFA_SETUP_REQUIRED = 'MFA_SETUP_REQUIRED',

  // Injection
  INJECTION_SQL_DETECTED = 'INJECTION_SQL_DETECTED',
  INJECTION_XSS_DETECTED = 'INJECTION_XSS_DETECTED',
  INJECTION_COMMAND_DETECTED = 'INJECTION_COMMAND_DETECTED',
  INJECTION_PROMPT_DETECTED = 'INJECTION_PROMPT_DETECTED',
  INJECTION_PATH_TRAVERSAL_DETECTED = 'INJECTION_PATH_TRAVERSAL_DETECTED',

  // Integrity
  INTEGRITY_HASH_MISMATCH = 'INTEGRITY_HASH_MISMATCH',
  INTEGRITY_SIGNATURE_INVALID = 'INTEGRITY_SIGNATURE_INVALID',
  INTEGRITY_CONTEXT_TAMPERED = 'INTEGRITY_CONTEXT_TAMPERED',

  // Feed
  FEED_DATA_STALE = 'FEED_DATA_STALE',
  FEED_CONSENSUS_DIVERGED = 'FEED_CONSENSUS_DIVERGED',
  FEED_SIGNATURE_INVALID = 'FEED_SIGNATURE_INVALID',
  FEED_ANOMALY_DETECTED = 'FEED_ANOMALY_DETECTED',
  FEED_UNAVAILABLE = 'FEED_UNAVAILABLE',

  // Action blocked
  ACTION_NOT_IN_UNIVERSE = 'ACTION_NOT_IN_UNIVERSE',
  ACTION_OUTSIDE_TRADING_HOURS = 'ACTION_OUTSIDE_TRADING_HOURS',
  ACTION_SANITY_CHECK_FAILED = 'ACTION_SANITY_CHECK_FAILED',
  ACTION_DUPLICATE_ORDER = 'ACTION_DUPLICATE_ORDER',
  ACTION_CONFIRMATION_REQUIRED = 'ACTION_CONFIRMATION_REQUIRED',
  ACTION_CONFIRMATION_EXPIRED = 'ACTION_CONFIRMATION_EXPIRED',

  // Risk limits
  RISK_POSITION_LIMIT_BREACHED = 'RISK_POSITION_LIMIT_BREACHED',
  RISK_NOTIONAL_LIMIT_BREACHED = 'RISK_NOTIONAL_LIMIT_BREACHED',
  RISK_LOSS_LIMIT_BREACHED = 'RISK_LOSS_LIMIT_BREACHED',
  RISK_DRAWDOWN_LIMIT_BREACHED = 'RISK_DRAWDOWN_LIMIT_BREACHED',

  // Circuit breaker
  CIRCUIT_BREAKER_OPEN = 'CIRCUIT_BREAKER_OPEN',
  CIRCUIT_BREAKER_VELOCITY_TRIP = 'CIRCUIT_BREAKER_VELOCITY_TRIP',
  CIRCUIT_BREAKER_ERROR_RATE_TRIP = 'CIRCUIT_BREAKER_ERROR_RATE_TRIP',
  KILL_SWITCH_ACTIVE = 'KILL_SWITCH_ACTIVE',

  // Compliance
  COMPLIANCE_WASH_TRADE = 'COMPLIANCE_WASH_TRADE',
  COMPLIANCE_LAYERING = 'COMPLIANCE_LAYERING',
  COMPLIANCE_SHORT_SELL_BLOCKED = 'COMPLIANCE_SHORT_SELL_BLOCKED',
  COMPLIANCE_TRADE_REPORTING_FAILED = 'COMPLIANCE_TRADE_REPORTING_FAILED',

  // Rate limiting
  RATE_LIMIT_USER = 'RATE_LIMIT_USER',
  RATE_LIMIT_STRATEGY = 'RATE_LIMIT_STRATEGY',
  RATE_LIMIT_INSTRUMENT = 'RATE_LIMIT_INSTRUMENT',
  RATE_LIMIT_EXCHANGE = 'RATE_LIMIT_EXCHANGE',

  // Secrets
  SECRET_NOT_FOUND = 'SECRET_NOT_FOUND',
  SECRET_DECRYPTION_FAILED = 'SECRET_DECRYPTION_FAILED',
  SECRET_ROTATION_FAILED = 'SECRET_ROTATION_FAILED',
  SECRET_KMS_UNAVAILABLE = 'SECRET_KMS_UNAVAILABLE',

  // Audit
  AUDIT_CHAIN_BROKEN = 'AUDIT_CHAIN_BROKEN',
  AUDIT_WRITE_FAILED = 'AUDIT_WRITE_FAILED',
  AUDIT_HMAC_MISMATCH = 'AUDIT_HMAC_MISMATCH',

  // Anomaly
  ANOMALY_PRICE_SPIKE = 'ANOMALY_PRICE_SPIKE',
  ANOMALY_VOLUME_SPIKE = 'ANOMALY_VOLUME_SPIKE',
  ANOMALY_STRATEGY_DRIFT = 'ANOMALY_STRATEGY_DRIFT',
  ANOMALY_BEHAVIORAL = 'ANOMALY_BEHAVIORAL',

  // Dead man switch
  DEAD_MAN_SWITCH_TRIGGERED = 'DEAD_MAN_SWITCH_TRIGGERED',

  // Device trust
  DEVICE_TRUST_DENIED = 'DEVICE_TRUST_DENIED',
}

// ─── Base Error Class ────────────────────────────────────────────────────────

export class SecurityError extends Error {
  public readonly code: SecurityErrorCode;
  public readonly riskLevel: RiskLevel;
  public readonly correlationId: string;
  public readonly context: Record<string, unknown>;

  constructor(
    message: string,
    code: SecurityErrorCode,
    riskLevel: RiskLevel,
    correlationId: string,
    context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'SecurityError';
    this.code = code;
    this.riskLevel = riskLevel;
    this.correlationId = correlationId;
    this.context = context;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  public toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      riskLevel: this.riskLevel,
      correlationId: this.correlationId,
      context: this.context,
    };
  }
}

// ─── Subclass Errors ─────────────────────────────────────────────────────────

export class AuthenticationError extends SecurityError {
  constructor(
    message: string,
    correlationId: string,
    code: SecurityErrorCode = SecurityErrorCode.AUTH_CREDENTIALS_INVALID,
    context: Record<string, unknown> = {},
  ) {
    super(
      `Authentication failed: ${message}`,
      code,
      RiskLevel.HIGH,
      correlationId,
      context,
    );
    this.name = 'AuthenticationError';
  }
}

export class AuthorizationError extends SecurityError {
  constructor(
    message: string,
    correlationId: string,
    code: SecurityErrorCode = SecurityErrorCode.AUTHZ_INSUFFICIENT_PERMISSIONS,
    context: Record<string, unknown> = {},
  ) {
    super(
      `Authorization denied: ${message}`,
      code,
      RiskLevel.MEDIUM,
      correlationId,
      context,
    );
    this.name = 'AuthorizationError';
  }
}

export class SessionError extends SecurityError {
  constructor(
    message: string,
    correlationId: string,
    code: SecurityErrorCode = SecurityErrorCode.SESSION_EXPIRED,
    context: Record<string, unknown> = {},
  ) {
    super(
      `Session error: ${message}`,
      code,
      RiskLevel.MEDIUM,
      correlationId,
      context,
    );
    this.name = 'SessionError';
  }
}

export class InjectionError extends SecurityError {
  constructor(
    message: string,
    correlationId: string,
    code: SecurityErrorCode = SecurityErrorCode.INJECTION_PROMPT_DETECTED,
    context: Record<string, unknown> = {},
  ) {
    super(
      `Injection detected: ${message}`,
      code,
      RiskLevel.CRITICAL,
      correlationId,
      context,
    );
    this.name = 'InjectionError';
  }
}

export class IntegrityError extends SecurityError {
  constructor(
    message: string,
    correlationId: string,
    code: SecurityErrorCode = SecurityErrorCode.INTEGRITY_HASH_MISMATCH,
    context: Record<string, unknown> = {},
  ) {
    super(
      `Integrity violation: ${message}`,
      code,
      RiskLevel.CRITICAL,
      correlationId,
      context,
    );
    this.name = 'IntegrityError';
  }
}

export class FeedError extends SecurityError {
  constructor(
    message: string,
    correlationId: string,
    code: SecurityErrorCode = SecurityErrorCode.FEED_UNAVAILABLE,
    context: Record<string, unknown> = {},
  ) {
    super(
      `Market data feed error: ${message}`,
      code,
      RiskLevel.HIGH,
      correlationId,
      context,
    );
    this.name = 'FeedError';
  }
}

export class ActionBlockedError extends SecurityError {
  constructor(
    message: string,
    correlationId: string,
    code: SecurityErrorCode = SecurityErrorCode.ACTION_SANITY_CHECK_FAILED,
    context: Record<string, unknown> = {},
  ) {
    super(
      `Action blocked: ${message}`,
      code,
      RiskLevel.HIGH,
      correlationId,
      context,
    );
    this.name = 'ActionBlockedError';
  }
}

export class RiskLimitError extends SecurityError {
  constructor(
    message: string,
    correlationId: string,
    code: SecurityErrorCode = SecurityErrorCode.RISK_POSITION_LIMIT_BREACHED,
    context: Record<string, unknown> = {},
  ) {
    super(
      `Risk limit breached: ${message}`,
      code,
      RiskLevel.CRITICAL,
      correlationId,
      context,
    );
    this.name = 'RiskLimitError';
  }
}

export class CircuitBreakerError extends SecurityError {
  constructor(
    message: string,
    correlationId: string,
    code: SecurityErrorCode = SecurityErrorCode.CIRCUIT_BREAKER_OPEN,
    context: Record<string, unknown> = {},
  ) {
    super(
      `Circuit breaker tripped: ${message}`,
      code,
      RiskLevel.CRITICAL,
      correlationId,
      context,
    );
    this.name = 'CircuitBreakerError';
  }
}

export class ComplianceError extends SecurityError {
  constructor(
    message: string,
    correlationId: string,
    code: SecurityErrorCode = SecurityErrorCode.COMPLIANCE_WASH_TRADE,
    context: Record<string, unknown> = {},
  ) {
    super(
      `Compliance violation: ${message}`,
      code,
      RiskLevel.CRITICAL,
      correlationId,
      context,
    );
    this.name = 'ComplianceError';
  }
}

export class RateLimitError extends SecurityError {
  constructor(
    message: string,
    correlationId: string,
    code: SecurityErrorCode = SecurityErrorCode.RATE_LIMIT_USER,
    context: Record<string, unknown> = {},
  ) {
    super(
      `Rate limit exceeded: ${message}`,
      code,
      RiskLevel.MEDIUM,
      correlationId,
      context,
    );
    this.name = 'RateLimitError';
  }
}

export class SecretsError extends SecurityError {
  constructor(
    message: string,
    correlationId: string,
    code: SecurityErrorCode = SecurityErrorCode.SECRET_NOT_FOUND,
    context: Record<string, unknown> = {},
  ) {
    super(
      `Secrets management error: ${message}`,
      code,
      RiskLevel.HIGH,
      correlationId,
      context,
    );
    this.name = 'SecretsError';
  }
}

export class AuditError extends SecurityError {
  constructor(
    message: string,
    correlationId: string,
    code: SecurityErrorCode = SecurityErrorCode.AUDIT_CHAIN_BROKEN,
    context: Record<string, unknown> = {},
  ) {
    super(
      `Audit integrity error: ${message}`,
      code,
      RiskLevel.CRITICAL,
      correlationId,
      context,
    );
    this.name = 'AuditError';
  }
}

export class AnomalyError extends SecurityError {
  constructor(
    message: string,
    correlationId: string,
    code: SecurityErrorCode = SecurityErrorCode.ANOMALY_BEHAVIORAL,
    context: Record<string, unknown> = {},
  ) {
    super(
      `Anomaly detected: ${message}`,
      code,
      RiskLevel.HIGH,
      correlationId,
      context,
    );
    this.name = 'AnomalyError';
  }
}
