import { UndiciHttpService } from './undici-http.service';

jest.mock('undici', () => {
  const mockPool = {
    close: jest.fn().mockResolvedValue(undefined),
    request: jest.fn(),
  };
  return { Pool: jest.fn().mockImplementation(() => mockPool) };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const undici = require('undici');

function makeConfig(overrides: Record<string, string> = {}): any {
  const defaults: Record<string, string> = {
    FAST_LANE_USE_UNDICI_POOL: 'true',
    FAST_LANE_UNDICI_CONNECTIONS: '10',
    FAST_LANE_UNDICI_KEEPALIVE_MS: '60000',
    ...overrides,
  };
  return {
    get: jest.fn((key: string, fallback?: string) => defaults[key] ?? fallback),
  };
}

describe('UndiciHttpService', () => {
  beforeEach(() => {
    (undici.Pool as jest.Mock).mockClear();
  });

  it('getPool() creates a pool on first call and returns same pool on second call', () => {
    const svc = new UndiciHttpService(makeConfig());
    const pool1 = svc.getPool('https://example.com');
    const pool2 = svc.getPool('https://example.com');
    expect(pool1).toBe(pool2);
    expect(undici.Pool).toHaveBeenCalledTimes(1);
    expect(undici.Pool).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({
        connections: 10,
        keepAliveTimeout: 60000,
      }),
    );
  });

  it('getPool() for different origins returns different pools', () => {
    const svc = new UndiciHttpService(makeConfig());
    svc.getPool('https://a.example.com');
    svc.getPool('https://b.example.com');
    expect(undici.Pool).toHaveBeenCalledTimes(2);
  });

  it('isEnabled() reflects FAST_LANE_USE_UNDICI_POOL=true', () => {
    const svc = new UndiciHttpService(makeConfig());
    expect(svc.isEnabled()).toBe(true);
  });

  it('isEnabled() reflects FAST_LANE_USE_UNDICI_POOL=false', () => {
    const svc = new UndiciHttpService(
      makeConfig({ FAST_LANE_USE_UNDICI_POOL: 'false' }),
    );
    expect(svc.isEnabled()).toBe(false);
  });

  it('parses connections and keepalive from config', () => {
    const svc = new UndiciHttpService(
      makeConfig({
        FAST_LANE_UNDICI_CONNECTIONS: '25',
        FAST_LANE_UNDICI_KEEPALIVE_MS: '15000',
      }),
    );
    svc.getPool('https://example.com');
    expect(undici.Pool).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({
        connections: 25,
        keepAliveTimeout: 15000,
        keepAliveMaxTimeout: 150000,
      }),
    );
  });

  it('onModuleDestroy() closes all pools', async () => {
    const svc = new UndiciHttpService(makeConfig());
    svc.getPool('https://a.example.com');
    svc.getPool('https://b.example.com');

    // Both calls return the same mock pool object; close should be called for each origin
    const mockPoolInstance = (undici.Pool as jest.Mock).mock.results[0].value;
    await svc.onModuleDestroy();
    expect(mockPoolInstance.close).toHaveBeenCalled();
  });

  it('onModuleDestroy() handles pool close errors gracefully', async () => {
    const svc = new UndiciHttpService(makeConfig());
    svc.getPool('https://a.example.com');
    const mockPoolInstance = (undici.Pool as jest.Mock).mock.results[0].value;
    mockPoolInstance.close.mockRejectedValueOnce(new Error('boom'));
    await expect(svc.onModuleDestroy()).resolves.toBeUndefined();
  });
});
