import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { RiskLevel } from '../types/events.js';
import {
  AlertBus,
  WebhookAlertConsumer,
  SlackAlertConsumer,
  EmailAlertConsumer,
  LogAlertConsumer,
  type AnomalyEvent,
  type AlertConsumer,
  type AlertBusLogger,
  type HttpClient,
  type EmailTransport,
  type AuditLoggerPort,
} from './alert.bus.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<AnomalyEvent> = {}): AnomalyEvent {
  return {
    eventType: 'ANOMALY_DETECTED',
    riskLevel: RiskLevel.HIGH,
    userId: 'user-1',
    strategyId: 'strat-1',
    description: 'Test anomaly',
    payload: { foo: 'bar' },
    timestamp: '2026-04-12T00:00:00.000Z',
    ...overrides,
  };
}

function makeLogger(): AlertBusLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeHttpClient(status = 200): HttpClient {
  return {
    post: vi.fn<HttpClient['post']>().mockResolvedValue({ status }),
  };
}

// ─── AlertBus Tests ────────────────────────────────────────────────────────

describe('AlertBus', () => {
  let logger: AlertBusLogger;
  let bus: AlertBus;

  beforeEach(() => {
    logger = makeLogger();
    bus = new AlertBus(logger);
  });

  it('calls all registered consumers on emit', async () => {
    const consumer1: AlertConsumer = { consume: vi.fn<AlertConsumer['consume']>().mockResolvedValue(undefined) };
    const consumer2: AlertConsumer = { consume: vi.fn<AlertConsumer['consume']>().mockResolvedValue(undefined) };
    bus.register(consumer1);
    bus.register(consumer2);

    const event = makeEvent();
    await bus.emit(event);

    expect(consumer1.consume).toHaveBeenCalledWith(event);
    expect(consumer2.consume).toHaveBeenCalledWith(event);
  });

  it('does not block other consumers when one fails', async () => {
    const failingConsumer: AlertConsumer = {
      consume: vi.fn<AlertConsumer['consume']>().mockRejectedValue(new Error('boom')),
    };
    const succeedingConsumer: AlertConsumer = {
      consume: vi.fn<AlertConsumer['consume']>().mockResolvedValue(undefined),
    };
    bus.register(failingConsumer);
    bus.register(succeedingConsumer);

    const event = makeEvent();
    await bus.emit(event);

    expect(succeedingConsumer.consume).toHaveBeenCalledWith(event);
    expect(logger.error).toHaveBeenCalledWith(
      'AlertConsumer failed',
      expect.objectContaining({ consumerIndex: 0, reason: 'boom' }),
    );
  });

  it('logs failures with non-Error rejection reasons', async () => {
    const failingConsumer: AlertConsumer = {
      consume: vi.fn<AlertConsumer['consume']>().mockRejectedValue('string-error'),
    };
    bus.register(failingConsumer);

    await bus.emit(makeEvent());

    expect(logger.error).toHaveBeenCalledWith(
      'AlertConsumer failed',
      expect.objectContaining({ reason: 'string-error' }),
    );
  });

  it('handles zero consumers gracefully', async () => {
    await expect(bus.emit(makeEvent())).resolves.toBeUndefined();
  });

  it('handles multiple failing consumers', async () => {
    const fail1: AlertConsumer = {
      consume: vi.fn<AlertConsumer['consume']>().mockRejectedValue(new Error('fail1')),
    };
    const fail2: AlertConsumer = {
      consume: vi.fn<AlertConsumer['consume']>().mockRejectedValue(new Error('fail2')),
    };
    const success: AlertConsumer = {
      consume: vi.fn<AlertConsumer['consume']>().mockResolvedValue(undefined),
    };
    bus.register(fail1);
    bus.register(success);
    bus.register(fail2);

    await bus.emit(makeEvent());

    expect(success.consume).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(2);
  });
});

// ─── WebhookAlertConsumer Tests ────────────────────────────────────────────

describe('WebhookAlertConsumer', () => {
  it('sends POST with HMAC signature', async () => {
    const httpClient = makeHttpClient();
    const secret = 'test-hmac-secret-32-chars-minimum';
    const consumer = new WebhookAlertConsumer('https://hooks.example.com/alert', secret, httpClient);

    const event = makeEvent();
    await consumer.consume(event);

    const expectedBody = JSON.stringify(event);
    const expectedSig = createHmac('sha256', secret).update(expectedBody).digest('hex');

    expect(httpClient.post).toHaveBeenCalledWith(
      'https://hooks.example.com/alert',
      expectedBody,
      {
        'Content-Type': 'application/json',
        'X-Signature-SHA256': expectedSig,
      },
    );
  });
});

// ─── SlackAlertConsumer Tests ──────────────────────────────────────────────

describe('SlackAlertConsumer', () => {
  it('sends formatted message to slack webhook', async () => {
    const httpClient = makeHttpClient();
    const consumer = new SlackAlertConsumer('https://hooks.slack.com/services/xxx', httpClient);

    const event = makeEvent({ riskLevel: RiskLevel.CRITICAL, eventType: 'STRATEGY_DRIFT_DETECTED' });
    await consumer.consume(event);

    expect(httpClient.post).toHaveBeenCalledWith(
      'https://hooks.slack.com/services/xxx',
      expect.stringContaining('CRITICAL'),
      { 'Content-Type': 'application/json' },
    );

    const callArgs = vi.mocked(httpClient.post).mock.calls[0];
    const parsedBody: unknown = JSON.parse(callArgs?.[1] ?? '{}');
    expect(parsedBody).toEqual({
      text: '[CRITICAL] STRATEGY_DRIFT_DETECTED: Test anomaly',
    });
  });
});

// ─── EmailAlertConsumer Tests ──────────────────────────────────────────────

describe('EmailAlertConsumer', () => {
  it('sends email via transport interface', async () => {
    const transport: EmailTransport = {
      send: vi.fn<EmailTransport['send']>().mockResolvedValue(undefined),
    };
    const consumer = new EmailAlertConsumer(transport, 'alerts@example.com');

    const event = makeEvent({ riskLevel: RiskLevel.MEDIUM, eventType: 'ANOMALY_DETECTED' });
    await consumer.consume(event);

    expect(transport.send).toHaveBeenCalledWith(
      'alerts@example.com',
      '[MEDIUM] Security Alert: ANOMALY_DETECTED',
      JSON.stringify(event, null, 2),
    );
  });
});

// ─── LogAlertConsumer Tests ────────────────────────────────────────────────

describe('LogAlertConsumer', () => {
  it('writes event to audit logger', async () => {
    const auditLogger: AuditLoggerPort = {
      log: vi.fn(),
    };
    const consumer = new LogAlertConsumer(auditLogger);

    const event = makeEvent();
    await consumer.consume(event);

    expect(auditLogger.log).toHaveBeenCalledWith(
      'Alert: ANOMALY_DETECTED',
      expect.objectContaining({
        riskLevel: RiskLevel.HIGH,
        userId: 'user-1',
        strategyId: 'strat-1',
      }),
    );
  });
});
