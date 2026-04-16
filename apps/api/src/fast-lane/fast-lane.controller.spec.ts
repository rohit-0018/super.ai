import { UnauthorizedException } from '@nestjs/common';
import { FastLaneController } from './fast-lane.controller';

function makeController() {
  const fastLaneService: any = {
    executeFastSwap: jest.fn().mockResolvedValue({
      tradeId: 'trade-1',
      txHash: '0xabc',
      perfReport: { totalMs: 12, checkpoints: [] },
    }),
    getConfig: jest.fn().mockResolvedValue({ enabled: true }),
    updateConfig: jest.fn().mockResolvedValue({ enabled: false }),
    getMetrics: jest.fn().mockReturnValue([{ tradeId: 't1', totalMs: 10 }]),
  };
  const telegramLink: any = {
    resolveByChatId: jest.fn(),
  };
  const controller = new FastLaneController(fastLaneService, telegramLink);
  return { controller, fastLaneService, telegramLink };
}

describe('FastLaneController', () => {
  describe('POST /swap', () => {
    it('calls service.executeFastSwap with userId from req.user and channel from header', async () => {
      const { controller, fastLaneService } = makeController();
      await controller.swap(
        { user: { userId: 'u1' } },
        { tokenOut: 'BONK', amountUsd: 100 },
        'web',
      );
      expect(fastLaneService.executeFastSwap).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ tokenOut: 'BONK', amountUsd: 100 }),
        'web',
      );
    });

    it('defaults channel to "web" when header is missing', async () => {
      const { controller, fastLaneService } = makeController();
      await controller.swap(
        { user: { userId: 'u1' } },
        { tokenOut: 'BONK', amountUsd: 100 },
        undefined as any,
      );
      expect(fastLaneService.executeFastSwap).toHaveBeenCalledWith(
        'u1',
        expect.any(Object),
        'web',
      );
    });

    it('forwards optional fields (walletId, chain, slippageBps, tokenIn)', async () => {
      const { controller, fastLaneService } = makeController();
      await controller.swap(
        { user: { userId: 'u2' } },
        {
          tokenOut: 'JUP',
          amountUsd: 50,
          walletId: 'w-1',
          chain: 'SOLANA',
          slippageBps: 99,
          tokenIn: 'USDC',
        },
        'web',
      );
      const call = fastLaneService.executeFastSwap.mock.calls[0];
      expect(call[1]).toMatchObject({
        tokenOut: 'JUP',
        amountUsd: 50,
        walletId: 'w-1',
        chain: 'SOLANA',
        slippageBps: 99,
        tokenIn: 'USDC',
      });
    });
  });

  describe('GET /config', () => {
    it('calls service.getConfig with userId', async () => {
      const { controller, fastLaneService } = makeController();
      const r = await controller.getConfig({ user: { userId: 'u1' } });
      expect(fastLaneService.getConfig).toHaveBeenCalledWith('u1');
      expect(r).toEqual({ enabled: true });
    });
  });

  describe('PATCH /config', () => {
    it('calls service.updateConfig with patch body', async () => {
      const { controller, fastLaneService } = makeController();
      const r = await controller.updateConfig(
        { user: { userId: 'u1' } },
        { enabled: false, maxPerTradeUsd: 1000 },
      );
      expect(fastLaneService.updateConfig).toHaveBeenCalledWith('u1', {
        enabled: false,
        maxPerTradeUsd: 1000,
      });
      expect(r).toEqual({ enabled: false });
    });
  });

  describe('GET /metrics', () => {
    it('returns metrics array from service', () => {
      const { controller, fastLaneService } = makeController();
      const r = controller.getMetrics({ user: { userId: 'u1' } });
      expect(fastLaneService.getMetrics).toHaveBeenCalledWith('u1');
      expect(r).toEqual([{ tradeId: 't1', totalMs: 10 }]);
    });
  });

  describe('POST /telegram', () => {
    it('throws UnauthorizedException if chatId is not linked', async () => {
      const { controller, telegramLink } = makeController();
      telegramLink.resolveByChatId.mockResolvedValue(null);
      await expect(
        controller.telegram({ telegramChatId: '123', command: '/buy BONK 200' }),
      ).rejects.toThrow(UnauthorizedException);
      await expect(
        controller.telegram({ telegramChatId: '123', command: '/buy BONK 200' }),
      ).rejects.toThrow(/not linked/);
    });

    it('parses "/buy BONK 200" → tokenOut="BONK", amountUsd=200', async () => {
      const { controller, fastLaneService, telegramLink } = makeController();
      telegramLink.resolveByChatId.mockResolvedValue('u-tg');
      await controller.telegram({
        telegramChatId: 'chat-1',
        command: '/buy BONK 200',
      });
      expect(fastLaneService.executeFastSwap).toHaveBeenCalledWith(
        'u-tg',
        expect.objectContaining({
          tokenOut: 'BONK',
          amountUsd: 200,
          slippageBps: undefined,
        }),
        'telegram',
      );
    });

    it('parses "/buy BONK 200 150" → slippageBps=150', async () => {
      const { controller, fastLaneService, telegramLink } = makeController();
      telegramLink.resolveByChatId.mockResolvedValue('u-tg');
      await controller.telegram({
        telegramChatId: 'chat-1',
        command: '/buy BONK 200 150',
      });
      const call = fastLaneService.executeFastSwap.mock.calls[0];
      expect(call[1]).toMatchObject({
        tokenOut: 'BONK',
        amountUsd: 200,
        slippageBps: 150,
      });
      expect(call[2]).toBe('telegram');
    });

    it('rejects malformed command (missing amount)', async () => {
      const { controller, telegramLink } = makeController();
      telegramLink.resolveByChatId.mockResolvedValue('u-tg');
      await expect(
        controller.telegram({ telegramChatId: 'chat-1', command: '/buy BONK' }),
      ).rejects.toThrow(/Invalid command format/);
    });

    it('rejects malformed command (non-numeric amount)', async () => {
      const { controller, telegramLink } = makeController();
      telegramLink.resolveByChatId.mockResolvedValue('u-tg');
      await expect(
        controller.telegram({
          telegramChatId: 'chat-1',
          command: '/buy BONK abc',
        }),
      ).rejects.toThrow(/Invalid command format/);
    });

    it('rejects empty command', async () => {
      const { controller, telegramLink } = makeController();
      telegramLink.resolveByChatId.mockResolvedValue('u-tg');
      await expect(
        controller.telegram({ telegramChatId: 'chat-1', command: '' }),
      ).rejects.toThrow(/Invalid command format/);
    });

    it('calls executeFastSwap with channel="telegram"', async () => {
      const { controller, fastLaneService, telegramLink } = makeController();
      telegramLink.resolveByChatId.mockResolvedValue('u-tg');
      await controller.telegram({
        telegramChatId: 'chat-1',
        command: '/buy SOL 50',
      });
      expect(fastLaneService.executeFastSwap.mock.calls[0][2]).toBe('telegram');
    });

    it('handles /swap prefix the same as /buy', async () => {
      const { controller, fastLaneService, telegramLink } = makeController();
      telegramLink.resolveByChatId.mockResolvedValue('u-tg');
      await controller.telegram({
        telegramChatId: 'chat-1',
        command: '/swap JUP 75',
      });
      expect(fastLaneService.executeFastSwap).toHaveBeenCalledWith(
        'u-tg',
        expect.objectContaining({ tokenOut: 'JUP', amountUsd: 75 }),
        'telegram',
      );
    });
  });
});
