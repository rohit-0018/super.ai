import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface TradeIntent {
  userId: string;
  tokenAddress: string;
  chain: 'SOLANA' | 'EVM';
  notionalUsd: number;
  slippageBps: number;
  riskFlags?: string[];
}

export interface GuardrailDecision {
  ok: boolean;
  reason?: string;
}

@Injectable()
export class GuardrailsService {
  constructor(private prisma: PrismaService) {}

  async config(userId: string) {
    return this.prisma.guardrailConfig.upsert({
      where: { userId },
      update: {},
      create: { userId, whitelist: [], blacklist: [] },
    });
  }

  async update(userId: string, patch: Partial<{ perTradeUsd: number; dailyUsd: number; maxSlippageBps: number; whitelist: string[]; blacklist: string[]; killSwitch: boolean }>) {
    await this.config(userId);
    return this.prisma.guardrailConfig.update({ where: { userId }, data: patch });
  }

  async kill(userId: string) {
    return this.update(userId, { killSwitch: true });
  }

  async check(intent: TradeIntent): Promise<GuardrailDecision> {
    const cfg = await this.config(intent.userId);
    if (cfg.killSwitch) return { ok: false, reason: 'KILL_SWITCH_ON' };
    if (cfg.blacklist.includes(intent.tokenAddress)) return { ok: false, reason: 'TOKEN_BLACKLISTED' };
    if (cfg.whitelist.length && !cfg.whitelist.includes(intent.tokenAddress))
      return { ok: false, reason: 'TOKEN_NOT_WHITELISTED' };
    if (intent.notionalUsd > cfg.perTradeUsd)
      return { ok: false, reason: `PER_TRADE_LIMIT_$${cfg.perTradeUsd}` };
    if (intent.slippageBps > cfg.maxSlippageBps)
      return { ok: false, reason: `SLIPPAGE_CAP_${cfg.maxSlippageBps}bps` };
    if (intent.riskFlags?.includes('HONEYPOT')) return { ok: false, reason: 'HONEYPOT_FLAG' };

    const since = new Date(Date.now() - 24 * 3600_000);
    const used = await this.prisma.trade.aggregate({
      _sum: { priceUsd: true },
      where: { userId: intent.userId, createdAt: { gte: since }, mode: 'LIVE' },
    });
    const dayTotal = (used._sum.priceUsd ?? 0) + intent.notionalUsd;
    if (dayTotal > cfg.dailyUsd) return { ok: false, reason: `DAILY_CAP_$${cfg.dailyUsd}` };
    return { ok: true };
  }
}
