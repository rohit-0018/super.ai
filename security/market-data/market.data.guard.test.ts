import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GuardRedisAdapter, GuardLogger } from './market.data.guard.js';
import { MarketDataGuard } from './market.data.guard.js';
import type { RawMarketDataPoint } from './feed.signature.verifier.js';
import type { FeedConsensus } from './feed.consensus.js';
import type { AnomalyFilter } from './anomaly.filter.js';
import type { FeedSignatureVerifier } from './feed.signature.verifier.js';
import type { SecurityConfig } from '../types/config.js';
import { FeedError, SecurityErrorCode } from '../types/errors.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeConfig(): SecurityConfig {
  return {} as unknown as SecurityConfig;
}

function makeLogger(): GuardLogger & { log: ReturnType<typeof vi.fn> } {
  return { log: vi.fn() };
}

function makeRedis(): GuardRedisAdapter & Record<string, ReturnType<typeof vi.fn>> {
  return {
    lpush: vi.fn(async () => undefined),
    ltrim: vi.fn(async () => undefined),
  };
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

function makeFeedConsensus(
  overrides: Partial<FeedConsensus> = {},
): FeedConsensus {
  return {
    check: vi.fn(async () => ({
      consensus: true,
      sources: [{ name: 'binance', price: 50000 }],
      divergencePercent: 0,
    })),
    ...overrides,
  } as unknown as FeedConsensus;
}

function makeAnomalyFilter(
  overrides: Partial<AnomalyFilter> = {},
): AnomalyFilter {
  return {
    check: vi.fn(async () => ({
      anomalous: false,
      mean: 50000,
      stdDev: 100,
      deviations: 0.5,
    })),
    ...overrides,
  } as unknown as AnomalyFilter;
}

function makeSignatureVerifier(
  overrides: Partial<FeedSignatureVerifier> = {},
): FeedSignatureVerifier {
  return {
    verify: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as FeedSignatureVerifier;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('MarketDataGuard', () => {
  let config: SecurityConfig;
  let logger: ReturnType<typeof makeLogger>;
  let redis: ReturnType<typeof makeRedis>;
  let feedConsensus: ReturnType<typeof makeFeedConsensus>;
  let anomalyFilter: ReturnType<typeof makeAnomalyFilter>;
  let signatureVerifier: ReturnType<typeof makeSignatureVerifier>;
  let guard: MarketDataGuard;

  beforeEach(() => {
    config = makeConfig();
    logger = makeLogger();
    redis = makeRedis();
    feedConsensus = makeFeedConsensus();
    anomalyFilter = makeAnomalyFilter();
    signatureVerifier = makeSignatureVerifier();
    guard = new MarketDataGuard(
      config,
      logger,
      redis,
      feedConsensus,
      anomalyFilter,
      signatureVerifier,
    );
  });

  it('should return validated data point when all checks pass', async () => {
    const dp = makeDataPoint();
    const result = await guard.validate(dp);

    expect(result.instrument).toBe('BTC-USDT');
    expect(result.price).toBe(50000);
    expect(result.volume).toBe(1.5);
    expect(result.source).toBe('binance');
    expect(result.validatedAt).toBeDefined();
    expect(result.correlationId).toBeDefined();
  });

  it('should run validators in sequence: signature -> consensus -> anomaly', async () => {
    const callOrder: string[] = [];

    (signatureVerifier.verify as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push('signature');
    });
    (feedConsensus.check as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push('consensus');
      return { consensus: true, sources: [], divergencePercent: 0 };
    });
    (anomalyFilter.check as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push('anomaly');
      return { anomalous: false, mean: 0, stdDev: 0, deviations: 0 };
    });

    await guard.validate(makeDataPoint());

    expect(callOrder).toEqual(['signature', 'consensus', 'anomaly']);
  });

  it('should throw and quarantine when signature verification fails', async () => {
    const sigError = new FeedError(
      'Signature missing',
      'test-corr-id',
      SecurityErrorCode.FEED_SIGNATURE_INVALID,
    );

    signatureVerifier = makeSignatureVerifier({
      verify: vi.fn(async () => {
        throw sigError;
      }) as FeedSignatureVerifier['verify'],
    });
    guard = new MarketDataGuard(
      config,
      logger,
      redis,
      feedConsensus,
      anomalyFilter,
      signatureVerifier,
    );

    await expect(guard.validate(makeDataPoint())).rejects.toThrow(FeedError);
    expect(redis.lpush).toHaveBeenCalledWith(
      'feed:quarantine',
      expect.stringContaining('Signature verification failed'),
    );
  });

  it('should throw and quarantine when consensus fails', async () => {
    feedConsensus = makeFeedConsensus({
      check: vi.fn(async () => ({
        consensus: false,
        sources: [
          { name: 'binance', price: 50000 },
          { name: 'coinbase', price: 52000 },
        ],
        divergencePercent: 4.0,
      })) as FeedConsensus['check'],
    });
    guard = new MarketDataGuard(
      config,
      logger,
      redis,
      feedConsensus,
      anomalyFilter,
      signatureVerifier,
    );

    await expect(guard.validate(makeDataPoint())).rejects.toThrow(FeedError);
    await expect(guard.validate(makeDataPoint())).rejects.toThrow(
      /Feed consensus failure/,
    );
    expect(redis.lpush).toHaveBeenCalled();
  });

  it('should throw and quarantine when anomaly is detected', async () => {
    anomalyFilter = makeAnomalyFilter({
      check: vi.fn(async () => ({
        anomalous: true,
        mean: 50000,
        stdDev: 100,
        deviations: 5.0,
      })) as AnomalyFilter['check'],
    });
    guard = new MarketDataGuard(
      config,
      logger,
      redis,
      feedConsensus,
      anomalyFilter,
      signatureVerifier,
    );

    await expect(guard.validate(makeDataPoint())).rejects.toThrow(FeedError);
    await expect(guard.validate(makeDataPoint())).rejects.toThrow(
      /Anomaly detected/,
    );
    expect(redis.lpush).toHaveBeenCalled();
  });

  it('should not call anomaly filter if consensus fails', async () => {
    feedConsensus = makeFeedConsensus({
      check: vi.fn(async () => ({
        consensus: false,
        sources: [],
        divergencePercent: 10,
      })) as FeedConsensus['check'],
    });
    guard = new MarketDataGuard(
      config,
      logger,
      redis,
      feedConsensus,
      anomalyFilter,
      signatureVerifier,
    );

    await expect(guard.validate(makeDataPoint())).rejects.toThrow();
    expect(anomalyFilter.check).not.toHaveBeenCalled();
  });

  it('should not call consensus or anomaly if signature fails', async () => {
    signatureVerifier = makeSignatureVerifier({
      verify: vi.fn(async () => {
        throw new FeedError('bad sig', 'id', SecurityErrorCode.FEED_SIGNATURE_INVALID);
      }) as FeedSignatureVerifier['verify'],
    });
    guard = new MarketDataGuard(
      config,
      logger,
      redis,
      feedConsensus,
      anomalyFilter,
      signatureVerifier,
    );

    await expect(guard.validate(makeDataPoint())).rejects.toThrow();
    expect(feedConsensus.check).not.toHaveBeenCalled();
    expect(anomalyFilter.check).not.toHaveBeenCalled();
  });

  it('should trim quarantine list to max length', async () => {
    feedConsensus = makeFeedConsensus({
      check: vi.fn(async () => ({
        consensus: false,
        sources: [],
        divergencePercent: 10,
      })) as FeedConsensus['check'],
    });
    guard = new MarketDataGuard(
      config,
      logger,
      redis,
      feedConsensus,
      anomalyFilter,
      signatureVerifier,
    );

    await expect(guard.validate(makeDataPoint())).rejects.toThrow();
    expect(redis.ltrim).toHaveBeenCalledWith('feed:quarantine', 0, 999);
  });

  it('should log quarantine event', async () => {
    feedConsensus = makeFeedConsensus({
      check: vi.fn(async () => ({
        consensus: false,
        sources: [],
        divergencePercent: 10,
      })) as FeedConsensus['check'],
    });
    guard = new MarketDataGuard(
      config,
      logger,
      redis,
      feedConsensus,
      anomalyFilter,
      signatureVerifier,
    );

    await expect(guard.validate(makeDataPoint())).rejects.toThrow();
    expect(logger.log).toHaveBeenCalled();
  });
});
