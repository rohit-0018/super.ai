jest.mock('@solana/web3.js', () => ({
  Connection: jest.fn().mockImplementation((url: string) => ({
    sendRawTransaction: jest.fn(),
    getSignatureStatus: jest.fn(),
    _url: url,
  })),
}));

import { ParallelRpcClient } from './parallel-rpc.client';

function makeConfig(overrides: Record<string, string> = {}): any {
  const defaults: Record<string, string> = {
    FAST_LANE_USE_PARALLEL_RPC: 'true',
    FAST_LANE_SOLANA_RPCS: 'https://rpc1.example.com,https://rpc2.example.com',
    ...overrides,
  };
  return {
    get: jest.fn((key: string, fallback?: string) => defaults[key] ?? fallback),
  };
}

describe('ParallelRpcClient', () => {
  it('constructor initializes connections from comma-separated FAST_LANE_SOLANA_RPCS', () => {
    const client = new ParallelRpcClient(
      makeConfig({
        FAST_LANE_SOLANA_RPCS: 'https://a.io,https://b.io,https://c.io',
      }),
    );
    const conns = client.getConnections();
    expect(conns).toHaveLength(3);
    expect(conns[0].url).toBe('https://a.io');
    expect(conns[1].url).toBe('https://b.io');
    expect(conns[2].url).toBe('https://c.io');
  });

  it('isEnabled() returns false when only 1 RPC is configured', () => {
    const client = new ParallelRpcClient(
      makeConfig({ FAST_LANE_SOLANA_RPCS: 'https://only.io' }),
    );
    expect(client.isEnabled()).toBe(false);
  });

  it('isEnabled() returns true with 2+ RPCs and feature enabled', () => {
    const client = new ParallelRpcClient(makeConfig());
    expect(client.isEnabled()).toBe(true);
  });

  it('primaryConnection() returns the first connection', () => {
    const client = new ParallelRpcClient(makeConfig());
    const primary = client.primaryConnection();
    expect((primary as any)._url).toBe('https://rpc1.example.com');
  });

  it('sendParallel() with 1 RPC calls that RPC directly', async () => {
    const client = new ParallelRpcClient(
      makeConfig({ FAST_LANE_SOLANA_RPCS: 'https://only.io' }),
    );
    const conns = client.getConnections();
    (conns[0].conn.sendRawTransaction as jest.Mock).mockResolvedValue('sig-only');
    const r = await client.sendParallel(new Uint8Array([1, 2, 3]));
    expect(r.signature).toBe('sig-only');
    expect(r.winningRpc).toBe('https://only.io');
    expect(r.attemptCount).toBe(1);
  });

  it('sendParallel() with 3 RPCs uses Promise.any — first resolver wins', async () => {
    const client = new ParallelRpcClient(
      makeConfig({
        FAST_LANE_SOLANA_RPCS: 'https://a.io,https://b.io,https://c.io',
      }),
    );
    const conns = client.getConnections();
    (conns[0].conn.sendRawTransaction as jest.Mock).mockImplementation(
      () => new Promise((res) => setTimeout(() => res('sig-a'), 100)),
    );
    (conns[1].conn.sendRawTransaction as jest.Mock).mockResolvedValue('sig-b');
    (conns[2].conn.sendRawTransaction as jest.Mock).mockImplementation(
      () => new Promise((res) => setTimeout(() => res('sig-c'), 50)),
    );

    const r = await client.sendParallel(new Uint8Array([1]));
    expect(r.signature).toBe('sig-b');
    expect(r.winningRpc).toBe('https://b.io');
    expect(r.attemptCount).toBe(3);
  });

  it('sendParallel() throws if all RPCs fail', async () => {
    const client = new ParallelRpcClient(makeConfig());
    const conns = client.getConnections();
    (conns[0].conn.sendRawTransaction as jest.Mock).mockRejectedValue(
      new Error('rpc1 down'),
    );
    (conns[1].conn.sendRawTransaction as jest.Mock).mockRejectedValue(
      new Error('rpc2 down'),
    );

    await expect(client.sendParallel(new Uint8Array([1]))).rejects.toThrow(
      /All 2 RPCs failed/,
    );
  });

  it('confirmSignature() returns true once a connection reports confirmed', async () => {
    const client = new ParallelRpcClient(makeConfig());
    const conns = client.getConnections();
    (conns[0].conn.getSignatureStatus as jest.Mock).mockResolvedValue({
      value: { confirmationStatus: 'confirmed' },
    });
    (conns[1].conn.getSignatureStatus as jest.Mock).mockResolvedValue({
      value: null,
    });
    const ok = await client.confirmSignature('sig-xyz', 5000);
    expect(ok).toBe(true);
  });

  it('confirmSignature() returns false when all RPCs report tx error', async () => {
    const client = new ParallelRpcClient(makeConfig());
    const conns = client.getConnections();
    (conns[0].conn.getSignatureStatus as jest.Mock).mockResolvedValue({
      value: { err: { InstructionError: 'oops' } },
    });
    (conns[1].conn.getSignatureStatus as jest.Mock).mockResolvedValue({
      value: { err: { InstructionError: 'oops' } },
    });
    const ok = await client.confirmSignature('sig-xyz', 5000);
    expect(ok).toBe(false);
  });
});
