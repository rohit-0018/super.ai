import { z } from 'zod';
import * as jose from 'jose';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { SecurityConfig } from '../types/config.js';
import { SecurityEventType, RiskLevel } from '../types/events.js';
import { AuthenticationError } from '../types/errors.js';
import { SecurityErrorCode } from '../types/errors.js';

// ─── Interfaces ─────────────────────────────────────────────────────────────

export interface AuditLogger {
  log(event: {
    eventType: SecurityEventType;
    timestamp: string;
    correlationId: string;
    riskLevel: RiskLevel;
    payload: Record<string, unknown>;
  }): void;
}

// ─── Zod Schemas ────────────────────────────────────────────────────────────

export const ValidatedTokenSchema = z.object({
  userId: z.string().min(1),
  sessionId: z.string().min(1),
  scope: z.array(z.string()),
  issuedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  deviceFingerprint: z.string().min(1),
});

export type ValidatedToken = z.infer<typeof ValidatedTokenSchema>;

export const TokenPairSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
});

export type TokenPair = z.infer<typeof TokenPairSchema>;

// ─── JwtValidator ───────────────────────────────────────────────────────────

export class JwtValidator {
  private readonly config: SecurityConfig;
  private readonly logger: AuditLogger;
  private publicKeyCache: jose.KeyLike | null = null;
  private privateKeyCache: jose.KeyLike | null = null;

  constructor(config: SecurityConfig, logger: AuditLogger) {
    this.config = config;
    this.logger = logger;
  }

  private async getPublicKey(): Promise<jose.KeyLike> {
    if (this.publicKeyCache) {
      return this.publicKeyCache;
    }
    const keyData = await readFile(this.config.jwtPublicKeyPath, 'utf-8');
    const key = await jose.importSPKI(keyData.trim(), 'RS256');
    this.publicKeyCache = key;
    return key;
  }

  private async getPrivateKey(): Promise<jose.KeyLike> {
    if (this.privateKeyCache) {
      return this.privateKeyCache;
    }
    const keyData = await readFile(this.config.jwtPrivateKeyPath, 'utf-8');
    const key = await jose.importPKCS8(keyData.trim(), 'RS256');
    this.privateKeyCache = key;
    return key;
  }

  public async validate(token: string, requiredScope: string): Promise<ValidatedToken> {
    const correlationId = randomUUID();
    try {
      const publicKey = await this.getPublicKey();

      const { payload } = await jose.jwtVerify(token, publicKey, {
        algorithms: ['RS256'],
      });

      const parsed = ValidatedTokenSchema.parse({
        userId: payload.sub,
        sessionId: payload.sid,
        scope: payload.scope,
        issuedAt: payload.iat,
        expiresAt: payload.exp,
        deviceFingerprint: payload.dfp,
      });

      const now = Math.floor(Date.now() / 1000);
      if (parsed.expiresAt <= now) {
        throw new AuthenticationError(
          'Token has expired',
          correlationId,
          SecurityErrorCode.AUTH_TOKEN_EXPIRED,
          { userId: parsed.userId },
        );
      }

      if (!parsed.scope.includes(requiredScope)) {
        throw new AuthenticationError(
          `Missing required scope: ${requiredScope}`,
          correlationId,
          SecurityErrorCode.AUTHZ_INSUFFICIENT_PERMISSIONS,
          { userId: parsed.userId, requiredScope, availableScopes: parsed.scope },
        );
      }

      this.logger.log({
        eventType: SecurityEventType.AUTH_SUCCESS,
        timestamp: new Date().toISOString(),
        correlationId,
        riskLevel: RiskLevel.LOW,
        payload: {
          userId: parsed.userId,
          ip: 'unknown',
          userAgent: 'unknown',
          method: 'jwt' as const,
        },
      });

      return parsed;
    } catch (error) {
      if (error instanceof AuthenticationError) {
        this.logger.log({
          eventType: SecurityEventType.AUTH_FAILURE,
          timestamp: new Date().toISOString(),
          correlationId,
          riskLevel: RiskLevel.HIGH,
          payload: {
            ip: 'unknown',
            userAgent: 'unknown',
            reason: error.message,
            attemptCount: 1,
          },
        });
        throw error;
      }

      const reason = error instanceof Error ? error.message : 'Unknown verification failure';
      this.logger.log({
        eventType: SecurityEventType.AUTH_FAILURE,
        timestamp: new Date().toISOString(),
        correlationId,
        riskLevel: RiskLevel.HIGH,
        payload: {
          ip: 'unknown',
          userAgent: 'unknown',
          reason,
          attemptCount: 1,
        },
      });

      throw new AuthenticationError(
        reason,
        correlationId,
        SecurityErrorCode.AUTH_TOKEN_INVALID,
      );
    }
  }

  public async generateAccessToken(
    userId: string,
    sessionId: string,
    scope: string[],
    deviceFingerprint: string,
  ): Promise<string> {
    const privateKey = await this.getPrivateKey();
    const now = Math.floor(Date.now() / 1000);

    const jwt = await new jose.SignJWT({
      sub: userId,
      sid: sessionId,
      scope,
      dfp: deviceFingerprint,
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt(now)
      .setExpirationTime(now + this.config.accessTokenExpirySeconds)
      .sign(privateKey);

    return jwt;
  }

  public async generateRefreshToken(
    userId: string,
    sessionId: string,
    deviceFingerprint: string,
  ): Promise<string> {
    const privateKey = await this.getPrivateKey();
    const now = Math.floor(Date.now() / 1000);
    const jti = randomUUID();

    const jwt = await new jose.SignJWT({
      sub: userId,
      sid: sessionId,
      dfp: deviceFingerprint,
      scope: ['refresh'],
      jti,
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt(now)
      .setExpirationTime(now + this.config.refreshTokenExpirySeconds)
      .sign(privateKey);

    return jwt;
  }
}
