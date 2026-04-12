import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import * as crypto from 'node:crypto';
import type { SignatureVerifierLogger, RawMarketDataPoint } from './feed.signature.verifier.js';
import { FeedSignatureVerifier } from './feed.signature.verifier.js';
import type { SecurityConfig } from '../types/config.js';
import { SecurityEventType, RiskLevel } from '../types/events.js';
import { FeedError, SecurityErrorCode } from '../types/errors.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

let ed25519PublicKeyPem: string;
let ed25519PrivateKey: crypto.KeyObject;

beforeAll(() => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  ed25519PublicKeyPem = publicKey
    .export({ type: 'spki', format: 'pem' })
    .toString();
  ed25519PrivateKey = privateKey;
});

function signDataPoint(dataPoint: Omit<RawMarketDataPoint, 'signature'>): string {
  const sorted = Object.keys(dataPoint)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = dataPoint[key as keyof typeof dataPoint];
      return acc;
    }, {});
  const canonical = JSON.stringify(sorted);
  const sig = crypto.sign(null, Buffer.from(canonical), ed25519PrivateKey);
  return sig.toString('base64');
}

function makeConfig(
  overrides: Partial<SecurityConfig> = {},
): SecurityConfig {
  return {
    feedSignaturePublicKeys: {},
    ...overrides,
  } as unknown as SecurityConfig;
}

function makeLogger(): SignatureVerifierLogger & { log: ReturnType<typeof vi.fn> } {
  return { log: vi.fn() };
}

function makeDataPoint(
  overrides: Partial<RawMarketDataPoint> = {},
): RawMarketDataPoint {
  return {
    instrument: 'BTC-USDT',
    price: 50000,
    volume: 1.5,
    timestamp: '2026-04-12T10:00:00.000Z',
    source: 'binance',
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('FeedSignatureVerifier', () => {
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    logger = makeLogger();
  });

  it('should pass when source is not in signing map (no verification needed)', async () => {
    const config = makeConfig({ feedSignaturePublicKeys: {} } as Partial<SecurityConfig>);
    const verifier = new FeedSignatureVerifier(config, logger);
    const dp = makeDataPoint();

    await expect(verifier.verify(dp)).resolves.toBeUndefined();
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('should throw FeedError when source is registered but signature is missing', async () => {
    const config = makeConfig({
      feedSignaturePublicKeys: { binance: ed25519PublicKeyPem },
    } as Partial<SecurityConfig>);
    const verifier = new FeedSignatureVerifier(config, logger);
    const dp = makeDataPoint({ signature: undefined });

    await expect(verifier.verify(dp)).rejects.toThrow(FeedError);
    await expect(verifier.verify(dp)).rejects.toThrow(/Signature missing/);

    expect(logger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: SecurityEventType.FEED_SIGNATURE_INVALID,
        riskLevel: RiskLevel.HIGH,
        payload: expect.objectContaining({
          reason: 'Signature missing for registered source',
        }),
      }),
    );
  });

  it('should pass with valid Ed25519 signature', async () => {
    const config = makeConfig({
      feedSignaturePublicKeys: { binance: ed25519PublicKeyPem },
    } as Partial<SecurityConfig>);
    const verifier = new FeedSignatureVerifier(config, logger);

    const base = makeDataPoint();
    const { signature: _sig, ...rest } = base;
    const validSig = signDataPoint(rest);
    const dp = makeDataPoint({ signature: validSig });

    await expect(verifier.verify(dp)).resolves.toBeUndefined();
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('should throw FeedError with invalid signature', async () => {
    const config = makeConfig({
      feedSignaturePublicKeys: { binance: ed25519PublicKeyPem },
    } as Partial<SecurityConfig>);
    const verifier = new FeedSignatureVerifier(config, logger);
    const dp = makeDataPoint({ signature: 'aW52YWxpZC1zaWduYXR1cmU=' });

    await expect(verifier.verify(dp)).rejects.toThrow(FeedError);
    await expect(verifier.verify(dp)).rejects.toThrow(
      /Signature verification failed/,
    );

    expect(logger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: SecurityEventType.FEED_SIGNATURE_INVALID,
        payload: expect.objectContaining({
          reason: 'Ed25519 signature verification failed',
        }),
      }),
    );
  });

  it('should throw when signature is corrupted / not valid base64', async () => {
    const config = makeConfig({
      feedSignaturePublicKeys: { binance: ed25519PublicKeyPem },
    } as Partial<SecurityConfig>);
    const verifier = new FeedSignatureVerifier(config, logger);
    const dp = makeDataPoint({ signature: '!!!not-base64!!!' });

    await expect(verifier.verify(dp)).rejects.toThrow(FeedError);
  });

  it('should verify using canonical JSON with sorted keys, excluding signature', async () => {
    const config = makeConfig({
      feedSignaturePublicKeys: { binance: ed25519PublicKeyPem },
    } as Partial<SecurityConfig>);
    const verifier = new FeedSignatureVerifier(config, logger);

    // Sign the data point properly
    const base = {
      instrument: 'BTC-USDT',
      price: 50000,
      volume: 1.5,
      timestamp: '2026-04-12T10:00:00.000Z',
      source: 'binance',
    };
    const validSig = signDataPoint(base);
    const dp = makeDataPoint({ signature: validSig });

    await expect(verifier.verify(dp)).resolves.toBeUndefined();
  });
});
