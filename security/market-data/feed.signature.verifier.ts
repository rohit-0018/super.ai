import { randomUUID } from 'node:crypto';
import * as crypto from 'node:crypto';
import { z } from 'zod';
import type { SecurityConfig } from '../types/config.js';
import { SecurityEventType, RiskLevel } from '../types/events.js';
import { FeedError, SecurityErrorCode } from '../types/errors.js';

// ─── Interfaces ─────────────────────────────────────────────────────────────

export interface SignatureVerifierLogger {
  log(event: {
    eventType: SecurityEventType;
    timestamp: string;
    correlationId: string;
    riskLevel: RiskLevel;
    payload: Record<string, unknown>;
  }): void;
}

// ─── Zod schema for raw market data ─────────────────────────────────────────

export const RawMarketDataPointSchema = z.object({
  instrument: z.string().min(1),
  price: z.number().positive(),
  volume: z.number().nonnegative(),
  timestamp: z.string().datetime(),
  source: z.string().min(1),
  signature: z.string().optional(),
});

export type RawMarketDataPoint = z.infer<typeof RawMarketDataPointSchema>;

// ─── Class ──────────────────────────────────────────────────────────────────

/**
 * Verifies Ed25519 signatures on incoming market data points.
 * Loads source -> publicKey mapping from config.feedSignaturePublicKeys.
 * If a source is in the map but provides no signature, throws.
 * Verifies Ed25519 signature over canonical JSON (all fields except `signature`).
 */
export class FeedSignatureVerifier {
  private readonly config: SecurityConfig;
  private readonly logger: SignatureVerifierLogger;

  constructor(config: SecurityConfig, logger: SignatureVerifierLogger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Build canonical JSON for signing: all fields except `signature`, keys sorted.
   */
  private buildCanonicalPayload(dataPoint: RawMarketDataPoint): string {
    const { signature: _sig, ...rest } = dataPoint;
    const sorted = Object.keys(rest)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = rest[key as keyof typeof rest];
        return acc;
      }, {});
    return JSON.stringify(sorted);
  }

  public async verify(dataPoint: RawMarketDataPoint): Promise<void> {
    const publicKeys = this.config.feedSignaturePublicKeys;
    const publicKeyPem = publicKeys[dataPoint.source];

    // If source is not in the signing map, no verification needed
    if (publicKeyPem === undefined) {
      return;
    }

    const correlationId = randomUUID();

    // Source is registered — signature is required
    if (!dataPoint.signature) {
      this.logger.log({
        eventType: SecurityEventType.FEED_SIGNATURE_INVALID,
        timestamp: new Date().toISOString(),
        correlationId,
        riskLevel: RiskLevel.HIGH,
        payload: {
          feedId: dataPoint.source,
          provider: dataPoint.source,
          reason: 'Signature missing for registered source',
        },
      });

      throw new FeedError(
        `Signature missing for source "${dataPoint.source}"`,
        correlationId,
        SecurityErrorCode.FEED_SIGNATURE_INVALID,
        { source: dataPoint.source, instrument: dataPoint.instrument },
      );
    }

    // Verify Ed25519 signature
    const canonical = this.buildCanonicalPayload(dataPoint);
    const signatureBuffer = Buffer.from(dataPoint.signature, 'base64');

    let valid: boolean;
    try {
      const keyObject = crypto.createPublicKey(publicKeyPem);
      valid = crypto.verify(
        null,
        Buffer.from(canonical),
        keyObject,
        signatureBuffer,
      );
    } catch {
      valid = false;
    }

    if (!valid) {
      this.logger.log({
        eventType: SecurityEventType.FEED_SIGNATURE_INVALID,
        timestamp: new Date().toISOString(),
        correlationId,
        riskLevel: RiskLevel.HIGH,
        payload: {
          feedId: dataPoint.source,
          provider: dataPoint.source,
          reason: 'Ed25519 signature verification failed',
        },
      });

      throw new FeedError(
        `Signature verification failed for source "${dataPoint.source}"`,
        correlationId,
        SecurityErrorCode.FEED_SIGNATURE_INVALID,
        { source: dataPoint.source, instrument: dataPoint.instrument },
      );
    }
  }
}
