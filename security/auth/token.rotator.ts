import { randomUUID } from 'node:crypto';
import * as jose from 'jose';
import { z } from 'zod';
import type { SecurityConfig } from '../types/config.js';
import { AuthenticationError, SecurityErrorCode } from '../types/errors.js';
import type { AuditLogger } from './jwt.validator.js';
import { JwtValidator, ValidatedTokenSchema } from './jwt.validator.js';

// ─── Interfaces ─────────────────────────────────────────────────────────────

export interface TokenRotatorRedisAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  setex(key: string, ttlSeconds: number, value: string): Promise<void>;
  del(key: string): Promise<void>;
}

// ─── Schemas ────────────────────────────────────────────────────────────────

export const TokenPairSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
});

export type TokenPair = z.infer<typeof TokenPairSchema>;

// ─── Constants ──────────────────────────────────────────────────────────────

const USED_REFRESH_PREFIX = 'refresh:used:';
const REFRESH_FAMILY_PREFIX = 'refresh:family:';

// ─── TokenRotator ───────────────────────────────────────────────────────────

export class TokenRotator {
  private readonly config: SecurityConfig;
  private readonly redis: TokenRotatorRedisAdapter;
  private readonly jwtValidator: JwtValidator;
  private readonly logger: AuditLogger;

  constructor(
    config: SecurityConfig,
    redis: TokenRotatorRedisAdapter,
    jwtValidator: JwtValidator,
    logger: AuditLogger,
  ) {
    this.config = config;
    this.redis = redis;
    this.jwtValidator = jwtValidator;
    this.logger = logger;
  }

  public async rotate(refreshToken: string): Promise<TokenPair> {
    const correlationId = randomUUID();

    // Verify the refresh token signature and extract payload
    let payload: jose.JWTPayload;
    try {
      const publicKeyData = await import('node:fs/promises').then(fs =>
        fs.readFile(this.config.jwtPublicKeyPath, 'utf-8'),
      );
      const publicKey = await jose.importSPKI(publicKeyData.trim(), 'RS256');
      const result = await jose.jwtVerify(refreshToken, publicKey, {
        algorithms: ['RS256'],
      });
      payload = result.payload;
    } catch (error) {
      throw new AuthenticationError(
        'Invalid refresh token',
        correlationId,
        SecurityErrorCode.AUTH_TOKEN_INVALID,
      );
    }

    const jti = payload.jti;
    if (!jti) {
      throw new AuthenticationError(
        'Refresh token missing jti claim',
        correlationId,
        SecurityErrorCode.AUTH_TOKEN_INVALID,
      );
    }

    // Check if this refresh token has already been used (replay detection)
    const usedKey = `${USED_REFRESH_PREFIX}${jti}`;
    const alreadyUsed = await this.redis.get(usedKey);

    if (alreadyUsed !== null) {
      // Replay attack detected — invalidate the entire token family
      const familyId = payload.fid as string | undefined ?? jti;
      const familyKey = `${REFRESH_FAMILY_PREFIX}${familyId}`;
      await this.redis.del(familyKey);

      this.logger.log({
        eventType: 'AUTH_FAILURE' as never,
        timestamp: new Date().toISOString(),
        correlationId,
        riskLevel: 'CRITICAL' as never,
        payload: {
          ip: 'unknown',
          userAgent: 'unknown',
          reason: 'Refresh token replay detected',
          attemptCount: 1,
        },
      });

      throw new AuthenticationError(
        'Refresh token replay detected',
        correlationId,
        SecurityErrorCode.AUTH_TOKEN_INVALID,
        { code: 'REFRESH_TOKEN_REPLAY' },
      );
    }

    // Mark this refresh token as used with TTL matching the refresh token expiry
    await this.redis.setex(
      usedKey,
      this.config.refreshTokenExpirySeconds,
      new Date().toISOString(),
    );

    // Validate the token contents via Zod
    const validated = ValidatedTokenSchema.parse({
      userId: payload.sub,
      sessionId: payload.sid,
      scope: payload.scope,
      issuedAt: payload.iat,
      expiresAt: payload.exp,
      deviceFingerprint: payload.dfp,
    });

    // Generate new tokens
    const newAccessToken = await this.jwtValidator.generateAccessToken(
      validated.userId,
      validated.sessionId,
      validated.scope,
      validated.deviceFingerprint,
    );

    const newRefreshToken = await this.jwtValidator.generateRefreshToken(
      validated.userId,
      validated.sessionId,
      validated.deviceFingerprint,
    );

    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    };
  }
}
