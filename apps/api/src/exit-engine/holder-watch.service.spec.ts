import { HolderWatchService } from './holder-watch.service';

function makeService(rows: Array<{ tokenOut: string }> = []) {
  const prisma: any = {
    trade: { findMany: jest.fn().mockResolvedValue(rows) },
  };
  const realtime: any = { emitGlobal: jest.fn(), emitToUser: jest.fn() };
  const service = new HolderWatchService(prisma, realtime);
  return { service, prisma, realtime };
}

// Drives checkToken with a scripted sequence of snapshots.
function withSnapshots(service: HolderWatchService, seq: Array<{ top10Sum: number; concentrationPct: number } | null>) {
  let i = 0;
  jest.spyOn(service as any, 'fetchSnapshot').mockImplementation(async () => {
    const s = seq[Math.min(i, seq.length - 1)];
    i++;
    return s ? { ...s, ts: Date.now() } : null;
  });
}

describe('HolderWatchService — dump detection', () => {
  afterEach(() => jest.restoreAllMocks());

  it('seeds a baseline on first observation without firing a signal', async () => {
    const { service } = makeService();
    withSnapshots(service, [{ top10Sum: 1000, concentrationPct: 40 }]);

    await (service as any).checkToken('tok');

    expect(service.consumeSignal('tok')).toBeNull();
  });

  it('raises insider_dump when the top-10 aggregate balance drops past the threshold', async () => {
    const { service, realtime } = makeService();
    withSnapshots(service, [
      { top10Sum: 1000, concentrationPct: 40 }, // baseline
      { top10Sum: 500,  concentrationPct: 30 }, // −50% → dump
    ]);

    await (service as any).checkToken('tok'); // seed
    await (service as any).checkToken('tok'); // detect

    expect(service.consumeSignal('tok')).toBe('insider_dump');
    expect(realtime.emitGlobal).toHaveBeenCalledWith('holder_dump', expect.objectContaining({ token: 'tok' }));
  });

  it('does not fire for a mild balance change', async () => {
    const { service } = makeService();
    withSnapshots(service, [
      { top10Sum: 1000, concentrationPct: 40 },
      { top10Sum: 950,  concentrationPct: 39 }, // −5%
    ]);

    await (service as any).checkToken('tok');
    await (service as any).checkToken('tok');

    expect(service.consumeSignal('tok')).toBeNull();
  });

  it('consumeSignal is fire-once', async () => {
    const { service } = makeService();
    withSnapshots(service, [
      { top10Sum: 1000, concentrationPct: 40 },
      { top10Sum: 400,  concentrationPct: 35 },
    ]);
    await (service as any).checkToken('tok');
    await (service as any).checkToken('tok');

    expect(service.consumeSignal('tok')).toBe('insider_dump');
    expect(service.consumeSignal('tok')).toBeNull(); // cleared after first read
  });

  it('emits a concentration-spike warning but NOT an auto-exit signal', async () => {
    const { service, realtime } = makeService();
    withSnapshots(service, [
      { top10Sum: 1000, concentrationPct: 40 },
      { top10Sum: 990,  concentrationPct: 60 }, // balance steady, concentration +20pts
    ]);

    await (service as any).checkToken('tok');
    await (service as any).checkToken('tok');

    expect(service.consumeSignal('tok')).toBeNull(); // spike is a warning, not a forced exit
    expect(realtime.emitGlobal).toHaveBeenCalledWith('holder_concentration_spike', expect.objectContaining({ token: 'tok' }));
  });
});

describe('HolderWatchService — dueTokens', () => {
  afterEach(() => jest.restoreAllMocks());

  it('queries distinct open Solana positions', async () => {
    const { service, prisma } = makeService([{ tokenOut: 'a' }, { tokenOut: 'b' }]);

    const tokens = await (service as any).dueTokens();

    expect(prisma.trade.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ distinct: ['tokenOut'], where: expect.objectContaining({ side: 'buy', exitAt: null, chain: 'SOLANA' }) }),
    );
    expect(tokens).toEqual(['a', 'b']);
  });
});
