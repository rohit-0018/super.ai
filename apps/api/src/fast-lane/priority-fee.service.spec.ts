import { PriorityFeeService } from './priority-fee.service';

function makeConfig(overrides: Record<string, string> = {}): any {
  const defaults: Record<string, string> = {
    FAST_LANE_PRIORITY_FEE_AUTO_TUNE: 'true',
    FAST_LANE_PRIORITY_FEE_MICROLAMPORTS: '50000',
    FAST_LANE_COMPUTE_UNIT_LIMIT: '300000',
    ...overrides,
  };
  return {
    get: jest.fn((key: string, fallback?: string) => defaults[key] ?? fallback),
  };
}

function makeRpc(fees: number[] = [1000, 5000, 50000, 100000]): any {
  const primaryConn: any = {
    getRecentPrioritizationFees: jest
      .fn()
      .mockResolvedValue(fees.map((prioritizationFee) => ({ prioritizationFee }))),
  };
  return {
    primaryConnection: () => primaryConn,
    _primary: primaryConn,
  };
}

describe('PriorityFeeService', () => {
  it('getFeeMicroLamports() returns manual fee when auto-tune disabled', async () => {
    const rpc = makeRpc();
    const svc = new PriorityFeeService(
      makeConfig({ FAST_LANE_PRIORITY_FEE_AUTO_TUNE: 'false' }),
      rpc,
    );
    const fee = await svc.getFeeMicroLamports();
    expect(fee).toBe(50000);
    expect(rpc._primary.getRecentPrioritizationFees).not.toHaveBeenCalled();
  });

  it('getFeeMicroLamports() uses p99 from getRecentPrioritizationFees when auto-tune enabled', async () => {
    // values sorted: [1000, 5000, 50000, 100000]
    // p99 idx = floor(4 * 0.99) = 3 -> 100000, but capped at manualFee*10 = 500000 (no cap hit)
    const rpc = makeRpc([1000, 5000, 50000, 100000]);
    const svc = new PriorityFeeService(makeConfig(), rpc);
    const fee = await svc.getFeeMicroLamports('p99');
    expect(fee).toBe(100000);
    expect(rpc._primary.getRecentPrioritizationFees).toHaveBeenCalledTimes(1);
  });

  it('caches result for 5s — second call within TTL does not hit RPC again', async () => {
    const rpc = makeRpc();
    const svc = new PriorityFeeService(makeConfig(), rpc);
    await svc.getFeeMicroLamports();
    await svc.getFeeMicroLamports();
    expect(rpc._primary.getRecentPrioritizationFees).toHaveBeenCalledTimes(1);
  });

  it('floors at manualFee', async () => {
    // All fees lower than manualFee -> should floor at manualFee (50000)
    const rpc = makeRpc([100, 200, 300, 400]);
    const svc = new PriorityFeeService(makeConfig(), rpc);
    const fee = await svc.getFeeMicroLamports();
    expect(fee).toBe(50000);
  });

  it('caps at 10x manualFee', async () => {
    // Huge p99 -> cap at 50000 * 10 = 500000
    const rpc = makeRpc([10_000_000, 20_000_000, 30_000_000, 99_000_000]);
    const svc = new PriorityFeeService(makeConfig(), rpc);
    const fee = await svc.getFeeMicroLamports();
    expect(fee).toBe(500000);
  });

  it('falls back to manual on RPC error', async () => {
    const primaryConn: any = {
      getRecentPrioritizationFees: jest.fn().mockRejectedValue(new Error('rpc down')),
    };
    const rpc: any = { primaryConnection: () => primaryConn };
    const svc = new PriorityFeeService(makeConfig(), rpc);
    const fee = await svc.getFeeMicroLamports();
    expect(fee).toBe(50000);
  });

  it('returns manual when RPC returns empty fees array', async () => {
    const rpc = makeRpc([]);
    const svc = new PriorityFeeService(makeConfig(), rpc);
    const fee = await svc.getFeeMicroLamports();
    expect(fee).toBe(50000);
  });

  it('buildComputeBudgetInstructions() returns 2 instructions (limit + price)', async () => {
    const rpc = makeRpc();
    const svc = new PriorityFeeService(makeConfig(), rpc);
    const ixs = await svc.buildComputeBudgetInstructions();
    expect(ixs).toHaveLength(2);
    // Both must be ComputeBudget program instructions
    for (const ix of ixs) {
      expect(ix.programId.toBase58()).toBe('ComputeBudget111111111111111111111111111111');
    }
  });

  it('getComputeUnitLimit() returns configured value', () => {
    const svc = new PriorityFeeService(
      makeConfig({ FAST_LANE_COMPUTE_UNIT_LIMIT: '450000' }),
      makeRpc(),
    );
    expect(svc.getComputeUnitLimit()).toBe(450000);
  });
});
