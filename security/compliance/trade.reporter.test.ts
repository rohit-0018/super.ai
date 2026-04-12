import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  TradeReporter,
  LocalJsonlTradeReporter,
  WebhookTradeReporter,
} from './trade.reporter.js';
import type {
  ExecutedTrade,
  Logger,
  AlertBus,
  FileSystem,
  HttpClient,
  TradeReportingAdapter,
} from './trade.reporter.js';
import { SecurityEventType, RiskLevel } from '../types/events.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeTrade(overrides: Partial<ExecutedTrade> = {}): ExecutedTrade {
  return {
    tradeId: 'trade-001',
    userId: 'user-1',
    strategyId: 'strat-1',
    instrument: 'BTC-USDT',
    side: 'BUY',
    quantity: 1.0,
    price: 50000,
    notional: 50000,
    timestamp: '2026-04-12T10:00:00.000Z',
    orderId: 'order-aaa-111',
    settlementDate: '2026-04-14',
    ...overrides,
  };
}

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeAlertBus(): AlertBus {
  return {
    emit: vi.fn(),
  };
}

function makeFs(): FileSystem {
  return {
    appendFile: vi.fn().mockResolvedValue(undefined),
  };
}

function makeHttpClient(status = 200): HttpClient {
  return {
    post: vi.fn().mockResolvedValue({ status, statusText: 'OK' }),
  };
}

// ─── LocalJsonlTradeReporter Tests ──────────────────────────────────────────

describe('LocalJsonlTradeReporter', () => {
  let fs: FileSystem;
  let reporter: LocalJsonlTradeReporter;

  beforeEach(() => {
    fs = makeFs();
    reporter = new LocalJsonlTradeReporter('/tmp/trades.jsonl', fs);
  });

  it('appends JSON line to the file', async () => {
    const trade = makeTrade();
    await reporter.report(trade);

    expect(fs.appendFile).toHaveBeenCalledWith(
      '/tmp/trades.jsonl',
      JSON.stringify(trade) + '\n',
    );
  });

  it('propagates fs errors', async () => {
    vi.mocked(fs.appendFile).mockRejectedValue(new Error('disk full'));

    await expect(reporter.report(makeTrade())).rejects.toThrow('disk full');
  });

  it('writes each trade as a separate line', async () => {
    await reporter.report(makeTrade({ tradeId: 'trade-001' }));
    await reporter.report(makeTrade({ tradeId: 'trade-002' }));

    expect(fs.appendFile).toHaveBeenCalledTimes(2);
    const firstCall = vi.mocked(fs.appendFile).mock.calls[0];
    const secondCall = vi.mocked(fs.appendFile).mock.calls[1];
    expect(firstCall?.[1]).toContain('trade-001');
    expect(secondCall?.[1]).toContain('trade-002');
  });
});

// ─── WebhookTradeReporter Tests ─────────────────────────────────────────────

describe('WebhookTradeReporter', () => {
  const hmacSecret = 'test-secret-key-32-chars-minimum!';
  let httpClient: HttpClient;
  let reporter: WebhookTradeReporter;

  beforeEach(() => {
    httpClient = makeHttpClient();
    reporter = new WebhookTradeReporter(
      'https://example.com/trades',
      hmacSecret,
      httpClient,
    );
  });

  it('POSTs the trade as JSON', async () => {
    const trade = makeTrade();
    await reporter.report(trade);

    expect(httpClient.post).toHaveBeenCalledWith(
      'https://example.com/trades',
      expect.objectContaining({
        body: JSON.stringify(trade),
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('includes HMAC signature in X-Signature header', async () => {
    const trade = makeTrade();
    const body = JSON.stringify(trade);
    const expectedSig = createHmac('sha256', hmacSecret)
      .update(body)
      .digest('hex');

    await reporter.report(trade);

    const call = vi.mocked(httpClient.post).mock.calls[0];
    expect(call?.[1]?.headers['X-Signature']).toBe(expectedSig);
  });

  it('throws on non-2xx response', async () => {
    httpClient = {
      post: vi.fn().mockResolvedValue({ status: 500, statusText: 'Internal Server Error' }),
    };
    reporter = new WebhookTradeReporter(
      'https://example.com/trades',
      hmacSecret,
      httpClient,
    );

    await expect(reporter.report(makeTrade())).rejects.toThrow(
      'Trade reporting webhook failed: 500 Internal Server Error',
    );
  });

  it('treats 201 as success', async () => {
    httpClient = makeHttpClient(201);
    reporter = new WebhookTradeReporter(
      'https://example.com/trades',
      hmacSecret,
      httpClient,
    );

    await expect(reporter.report(makeTrade())).resolves.toBeUndefined();
  });

  it('throws on 300 status', async () => {
    httpClient = {
      post: vi.fn().mockResolvedValue({ status: 300, statusText: 'Multiple Choices' }),
    };
    reporter = new WebhookTradeReporter(
      'https://example.com/trades',
      hmacSecret,
      httpClient,
    );

    await expect(reporter.report(makeTrade())).rejects.toThrow(
      'Trade reporting webhook failed',
    );
  });
});

// ─── TradeReporter (orchestrator) Tests ─────────────────────────────────────

describe('TradeReporter', () => {
  let logger: Logger;
  let alertBus: AlertBus;

  beforeEach(() => {
    logger = makeLogger();
    alertBus = makeAlertBus();
  });

  it('calls all adapters with the trade', async () => {
    const adapter1: TradeReportingAdapter = { report: vi.fn().mockResolvedValue(undefined) };
    const adapter2: TradeReportingAdapter = { report: vi.fn().mockResolvedValue(undefined) };

    const reporter = new TradeReporter([adapter1, adapter2], logger, alertBus);
    const trade = makeTrade();
    await reporter.report(trade);

    expect(adapter1.report).toHaveBeenCalledWith(trade);
    expect(adapter2.report).toHaveBeenCalledWith(trade);
  });

  it('emits TRADE_REPORTED event on success', async () => {
    const adapter: TradeReportingAdapter = { report: vi.fn().mockResolvedValue(undefined) };
    const reporter = new TradeReporter([adapter], logger, alertBus);

    await reporter.report(makeTrade());

    expect(alertBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        level: RiskLevel.LOW,
        type: SecurityEventType.TRADE_REPORTED,
      }),
    );
  });

  it('logs success with trade details', async () => {
    const adapter: TradeReportingAdapter = { report: vi.fn().mockResolvedValue(undefined) };
    const reporter = new TradeReporter([adapter], logger, alertBus);

    await reporter.report(makeTrade());

    expect(logger.info).toHaveBeenCalledWith(
      'Trade reported successfully',
      expect.objectContaining({
        tradeId: 'trade-001',
        instrument: 'BTC-USDT',
      }),
    );
  });

  it('throws when all adapters fail', async () => {
    const adapter1: TradeReportingAdapter = {
      report: vi.fn().mockRejectedValue(new Error('fail-1')),
    };
    const adapter2: TradeReportingAdapter = {
      report: vi.fn().mockRejectedValue(new Error('fail-2')),
    };

    const reporter = new TradeReporter([adapter1, adapter2], logger, alertBus);

    await expect(reporter.report(makeTrade())).rejects.toThrow(
      'All trade reporting adapters failed',
    );
  });

  it('succeeds if at least one adapter succeeds', async () => {
    const adapter1: TradeReportingAdapter = {
      report: vi.fn().mockRejectedValue(new Error('fail')),
    };
    const adapter2: TradeReportingAdapter = {
      report: vi.fn().mockResolvedValue(undefined),
    };

    const reporter = new TradeReporter([adapter1, adapter2], logger, alertBus);

    await expect(reporter.report(makeTrade())).resolves.toBeUndefined();
  });

  it('logs errors from failing adapters', async () => {
    const adapter1: TradeReportingAdapter = {
      report: vi.fn().mockRejectedValue(new Error('network timeout')),
    };
    const adapter2: TradeReportingAdapter = {
      report: vi.fn().mockResolvedValue(undefined),
    };

    const reporter = new TradeReporter([adapter1, adapter2], logger, alertBus);
    await reporter.report(makeTrade());

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('network timeout'),
      expect.objectContaining({ tradeId: 'trade-001' }),
    );
  });

  it('works with zero adapters without throwing', async () => {
    const reporter = new TradeReporter([], logger, alertBus);

    await expect(reporter.report(makeTrade())).resolves.toBeUndefined();
  });

  it('includes trade metadata in the alert', async () => {
    const adapter: TradeReportingAdapter = { report: vi.fn().mockResolvedValue(undefined) };
    const reporter = new TradeReporter([adapter], logger, alertBus);

    await reporter.report(makeTrade({ instrument: 'ETH-USDT', side: 'SELL' }));

    expect(alertBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          instrument: 'ETH-USDT',
          side: 'SELL',
        }),
      }),
    );
  });
});
