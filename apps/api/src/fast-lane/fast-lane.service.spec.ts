import { ForbiddenException } from '@nestjs/common';
import { FastLaneService } from './fast-lane.service';

function makeService(overrides: {
  envEnabled?: string;
  config?: Partial<{
    enabled: boolean;
    trustedChannels: string[];
    allowedTokens: string[];
    maxPerTradeUsd: number;
    maxDailyUsd: number;
    defaultSlippageBps: number;
    defaultWalletId: string | null;
  }>;
  daySumUsd?: number;
  swapResult?: any;
} = {}) {
  const cfg = {
    userId: 'u1',
    enabled: true,
    trustedChannels: ['web', 'telegram'],
    allowedTokens: [],
    maxPerTradeUsd: 500,
    maxDailyUsd: 2000,
    defaultSlippageBps: 200,
    defaultWalletId: 'w-default',
    ...overrides.config,
  };

  const prisma: any = {
    fastLaneConfig: {
      upsert: jest.fn().mockResolvedValue(cfg),
      update: jest.fn().mockImplementation(({ data }) =>
        Promise.resolve({ ...cfg, ...data }),
      ),
    },
    trade: {
      aggregate: jest.fn().mockResolvedValue({
        _sum: { priceUsd: overrides.daySumUsd ?? 0 },
      }),
    },
  };

  const swapResult = overrides.swapResult ?? {
    tradeId: 'trade-xyz',
    txHash: '0xabc',
    mode: 'LIVE',
    inAmount: '100',
    outAmount: '95',
  };

  const execution: any = {
    swap: jest.fn().mockResolvedValue(swapResult),
  };

  const config: any = {
    get: jest.fn().mockImplementation((_key: string, def?: any) => {
      return overrides.envEnabled ?? def ?? 'true';
    }),
  };

  const notifications: any = {
    emit: jest.fn().mockResolvedValue(undefined),
  };

  const svc = new FastLaneService(prisma, execution, config, notifications);
  return { svc, prisma, execution, config, notifications, cfg };
}

const baseInput = {
  tokenOut: 'BONK',
  amountUsd: 100,
};

describe('FastLaneService', () => {
  describe('config management', () => {
    it('getConfig() returns existing config', async () => {
      const { svc, prisma, cfg } = makeService();
      const r = await svc.getConfig('u1');
      expect(prisma.fastLaneConfig.upsert).toHaveBeenCalled();
      expect(r).toEqual(cfg);
    });

    it('getConfig() upserts default config (creates if missing)', async () => {
      const { svc, prisma } = makeService();
      await svc.getConfig('u1');
      const call = prisma.fastLaneConfig.upsert.mock.calls[0][0];
      expect(call.where).toEqual({ userId: 'u1' });
      expect(call.create).toMatchObject({
        userId: 'u1',
        enabled: false,
        trustedChannels: [],
        allowedTokens: [],
        maxPerTradeUsd: 500,
        maxDailyUsd: 2000,
        defaultSlippageBps: 200,
      });
    });

    it('updateConfig() updates and returns', async () => {
      const { svc, prisma } = makeService();
      const r = await svc.updateConfig('u1', { enabled: true, maxPerTradeUsd: 1000 });
      expect(prisma.fastLaneConfig.update).toHaveBeenCalledWith({
        where: { userId: 'u1' },
        data: { enabled: true, maxPerTradeUsd: 1000 },
      });
      expect(r).toMatchObject({ enabled: true, maxPerTradeUsd: 1000 });
    });
  });

  describe('executeFastSwap — happy path', () => {
    it('executes with fastLane:true flag and returns result with perfReport', async () => {
      const { svc, execution } = makeService();
      const r = await svc.executeFastSwap('u1', baseInput, 'web');

      expect(execution.swap).toHaveBeenCalledTimes(1);
      const callArg = execution.swap.mock.calls[0][0];
      expect(callArg.fastLane).toBe(true);
      expect(callArg.userId).toBe('u1');
      expect(callArg.tokenOut).toBe('BONK');

      expect(r.tradeId).toBe('trade-xyz');
      expect(r.perfReport).toBeDefined();
    });

    it('perfReport includes 4+ checkpoints with the expected names', async () => {
      const { svc } = makeService();
      const r = await svc.executeFastSwap('u1', baseInput, 'web');
      const names = r.perfReport.checkpoints.map((c) => c.name);
      expect(names.length).toBeGreaterThanOrEqual(4);
      expect(names).toEqual(
        expect.arrayContaining([
          'request_received',
          'config_loaded',
          'safety_checked',
          'swap_complete',
        ]),
      );
    });

    it('perfReport.totalMs > 0', async () => {
      const { svc } = makeService();
      const r = await svc.executeFastSwap('u1', baseInput, 'web');
      expect(r.perfReport.totalMs).toBeGreaterThanOrEqual(0);
    });

    it('emits FAST_LANE_FILL notification', async () => {
      const { svc, notifications } = makeService();
      await svc.executeFastSwap('u1', baseInput, 'web');
      // notifications.emit is fire-and-forget — wait a tick
      await new Promise((res) => setImmediate(res));
      expect(notifications.emit).toHaveBeenCalledTimes(1);
      const call = notifications.emit.mock.calls[0][0];
      expect(call.userId).toBe('u1');
      expect(call.kind).toBe('FAST_LANE_FILL');
      expect(call.payload).toMatchObject({
        tradeId: 'trade-xyz',
        tokenOut: 'BONK',
        amountUsd: 100,
        channel: 'web',
      });
    });
  });

  describe('safety checks', () => {
    it('throws ForbiddenException if FAST_LANE_ENABLED env is "false"', async () => {
      const { svc } = makeService({ envEnabled: 'false' });
      await expect(svc.executeFastSwap('u1', baseInput, 'web')).rejects.toThrow(
        ForbiddenException,
      );
      await expect(svc.executeFastSwap('u1', baseInput, 'web')).rejects.toThrow(
        /disabled globally/,
      );
    });

    it('throws if config.enabled = false', async () => {
      const { svc } = makeService({ config: { enabled: false } });
      await expect(svc.executeFastSwap('u1', baseInput, 'web')).rejects.toThrow(
        /not enabled for your account/,
      );
    });

    it('throws if channel not in trustedChannels', async () => {
      const { svc } = makeService({ config: { trustedChannels: ['web'] } });
      await expect(
        svc.executeFastSwap('u1', baseInput, 'telegram'),
      ).rejects.toThrow(/not in your trusted channels/);
    });

    it('throws if amountUsd > maxPerTradeUsd', async () => {
      const { svc } = makeService({ config: { maxPerTradeUsd: 50 } });
      await expect(
        svc.executeFastSwap('u1', { tokenOut: 'BONK', amountUsd: 100 }, 'web'),
      ).rejects.toThrow(/per-trade cap/);
    });

    it('throws if running daily sum would exceed maxDailyUsd', async () => {
      const { svc } = makeService({
        config: { maxDailyUsd: 200 },
        daySumUsd: 150,
      });
      await expect(
        svc.executeFastSwap('u1', { tokenOut: 'BONK', amountUsd: 100 }, 'web'),
      ).rejects.toThrow(/daily cap exceeded/);
    });

    it('throws if tokenOut not in allowedTokens (when allowedTokens non-empty)', async () => {
      const { svc } = makeService({ config: { allowedTokens: ['SOL', 'JUP'] } });
      await expect(
        svc.executeFastSwap('u1', { tokenOut: 'BONK', amountUsd: 100 }, 'web'),
      ).rejects.toThrow(/not in your fast-lane allowed tokens/);
    });

    it('allows any token when allowedTokens is empty', async () => {
      const { svc } = makeService({ config: { allowedTokens: [] } });
      await expect(
        svc.executeFastSwap('u1', { tokenOut: 'WHATEVER', amountUsd: 50 }, 'web'),
      ).resolves.toBeDefined();
    });
  });

  describe('metrics', () => {
    it('getMetrics() returns recent perf reports', async () => {
      const { svc } = makeService();
      await svc.executeFastSwap('u1', baseInput, 'web');
      await svc.executeFastSwap('u1', baseInput, 'web');
      const m = svc.getMetrics('u1');
      expect(m).toHaveLength(2);
      expect(m[0].tradeId).toBe('trade-xyz');
    });

    it('getMetrics() returns empty array for unknown user', () => {
      const { svc } = makeService();
      expect(svc.getMetrics('nobody')).toEqual([]);
    });

    it('reports are capped at MAX_RING (ring buffer)', async () => {
      const { svc } = makeService();
      // Push more than MAX_RING (100) reports
      for (let i = 0; i < 105; i++) {
        await svc.executeFastSwap('u1', baseInput, 'web');
      }
      const m = svc.getMetrics('u1');
      expect(m.length).toBeLessThanOrEqual(100);
      expect(m.length).toBe(100);
    });
  });

  describe('defaults', () => {
    it('falls back to config.defaultWalletId if walletId not provided', async () => {
      const { svc, execution } = makeService({
        config: { defaultWalletId: 'wallet-default' },
      });
      await svc.executeFastSwap('u1', baseInput, 'web');
      const call = execution.swap.mock.calls[0][0];
      expect(call.walletId).toBe('wallet-default');
    });

    it('uses provided walletId when given', async () => {
      const { svc, execution } = makeService();
      await svc.executeFastSwap(
        'u1',
        { ...baseInput, walletId: 'wallet-custom' },
        'web',
      );
      const call = execution.swap.mock.calls[0][0];
      expect(call.walletId).toBe('wallet-custom');
    });

    it('falls back to config.defaultSlippageBps if slippageBps not provided', async () => {
      const { svc, execution } = makeService({
        config: { defaultSlippageBps: 333 },
      });
      await svc.executeFastSwap('u1', baseInput, 'web');
      const call = execution.swap.mock.calls[0][0];
      expect(call.slippageBps).toBe(333);
    });

    it('uses provided slippageBps when given', async () => {
      const { svc, execution } = makeService();
      await svc.executeFastSwap(
        'u1',
        { ...baseInput, slippageBps: 77 },
        'web',
      );
      const call = execution.swap.mock.calls[0][0];
      expect(call.slippageBps).toBe(77);
    });

    it('chain defaults to SOLANA', async () => {
      const { svc, execution } = makeService();
      await svc.executeFastSwap('u1', baseInput, 'web');
      const call = execution.swap.mock.calls[0][0];
      expect(call.chain).toBe('SOLANA');
      // tokenIn defaults to USDC mint on Solana
      expect(call.tokenIn).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    });
  });
});
