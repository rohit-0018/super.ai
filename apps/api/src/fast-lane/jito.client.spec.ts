import { PublicKey } from '@solana/web3.js';
import { JitoClient } from './jito.client';

const FAKE_TIP = '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5';
const FAKE_TIP_2 = 'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe';

function makeConfig(overrides: Record<string, string> = {}): any {
  const defaults: Record<string, string> = {
    FAST_LANE_USE_JITO: 'true',
    FAST_LANE_JITO_URL: 'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
    FAST_LANE_JITO_TIP_LAMPORTS: '1000000',
    FAST_LANE_JITO_TIP_ACCOUNTS: `${FAKE_TIP},${FAKE_TIP_2}`,
    ...overrides,
  };
  return {
    get: jest.fn((key: string, fallback?: string) => defaults[key] ?? fallback),
  };
}

function makeHttp(overrides: any = {}): any {
  return {
    request: jest.fn().mockResolvedValue({
      statusCode: 200,
      body: { jsonrpc: '2.0', result: 'bundle-id-123', id: 1 },
      headers: {},
    }),
    ...overrides,
  };
}

describe('JitoClient', () => {
  it('isEnabled() false when FAST_LANE_USE_JITO=false', () => {
    const client = new JitoClient(
      makeConfig({ FAST_LANE_USE_JITO: 'false' }),
      makeHttp(),
    );
    expect(client.isEnabled()).toBe(false);
  });

  it('isEnabled() true when enabled and tip accounts present', () => {
    const client = new JitoClient(makeConfig(), makeHttp());
    expect(client.isEnabled()).toBe(true);
  });

  it('pickRandomTipAccount() returns one of the configured accounts', () => {
    const client = new JitoClient(makeConfig(), makeHttp());
    const account = client.pickRandomTipAccount();
    const validAccounts = [FAKE_TIP, FAKE_TIP_2];
    expect(validAccounts).toContain(account.toBase58());
  });

  it('getTipLamports() returns configured value', () => {
    const client = new JitoClient(
      makeConfig({ FAST_LANE_JITO_TIP_LAMPORTS: '2500000' }),
      makeHttp(),
    );
    expect(client.getTipLamports()).toBe(2500000);
  });

  it('buildTipInstruction() returns a SystemProgram.transfer instruction', () => {
    const client = new JitoClient(makeConfig(), makeHttp());
    const fromKey = new PublicKey(FAKE_TIP);
    const ix = client.buildTipInstruction(fromKey);
    expect(ix.programId.toBase58()).toBe('11111111111111111111111111111111');
    expect(ix.keys.length).toBeGreaterThanOrEqual(2);
    expect(ix.keys[0].pubkey.toBase58()).toBe(FAKE_TIP);
  });

  it('sendBundle() throws if not enabled', async () => {
    const client = new JitoClient(
      makeConfig({ FAST_LANE_USE_JITO: 'false' }),
      makeHttp(),
    );
    await expect(client.sendBundle(['tx1'])).rejects.toThrow(/not enabled/);
  });

  it('sendBundle() throws if bundle is empty', async () => {
    const client = new JitoClient(makeConfig(), makeHttp());
    await expect(client.sendBundle([])).rejects.toThrow(/1-5 transactions/);
  });

  it('sendBundle() throws if bundle has more than 5 txs', async () => {
    const client = new JitoClient(makeConfig(), makeHttp());
    await expect(
      client.sendBundle(['t1', 't2', 't3', 't4', 't5', 't6']),
    ).rejects.toThrow(/1-5 transactions/);
  });

  it('sendBundle() POSTs to Jito URL via UndiciHttpService and returns bundleId', async () => {
    const http = makeHttp();
    const client = new JitoClient(makeConfig(), http);
    const result = await client.sendBundle(['tx-base64']);
    expect(result).toBe('bundle-id-123');
    expect(http.request).toHaveBeenCalledTimes(1);
    const [origin, opts] = http.request.mock.calls[0];
    expect(origin).toBe('https://mainnet.block-engine.jito.wtf');
    expect(opts.method).toBe('POST');
    expect(opts.path).toBe('/api/v1/bundles');
    const parsed = JSON.parse(opts.body);
    expect(parsed.method).toBe('sendBundle');
    expect(parsed.params).toEqual([['tx-base64']]);
  });

  it('sendBundle() throws if Jito returns an error in body', async () => {
    const http = makeHttp({
      request: jest.fn().mockResolvedValue({
        statusCode: 200,
        body: {
          jsonrpc: '2.0',
          error: { code: -32000, message: 'bundle invalid' },
          id: 1,
        },
        headers: {},
      }),
    });
    const client = new JitoClient(makeConfig(), http);
    await expect(client.sendBundle(['tx'])).rejects.toThrow(/Jito error -32000/);
  });

  it('sendBundle() throws if Jito returns no result', async () => {
    const http = makeHttp({
      request: jest.fn().mockResolvedValue({
        statusCode: 200,
        body: { jsonrpc: '2.0', id: 1 },
        headers: {},
      }),
    });
    const client = new JitoClient(makeConfig(), http);
    await expect(client.sendBundle(['tx'])).rejects.toThrow(/no result/);
  });
});
