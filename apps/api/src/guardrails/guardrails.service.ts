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

  async concentrationCheck(userId: string, tokenAddress: string, addUsd: number): Promise<GuardrailDecision> {
    const trades = await this.prisma.trade.findMany({
      where: { userId, mode: 'LIVE' },
      select: { tokenOut: true, priceUsd: true },
    });
    const portfolio = new Map<string, number>();
    for (const t of trades) {
      const key = t.tokenOut.slice(0, 10);
      portfolio.set(key, (portfolio.get(key) ?? 0) + (t.priceUsd ?? 0));
    }
    const total = Array.from(portfolio.values()).reduce((s, v) => s + v, 0) + addUsd;
    if (total <= 0) return { ok: true };
    const tokenKey = tokenAddress.slice(0, 10);
    const exposure = ((portfolio.get(tokenKey) ?? 0) + addUsd) / total;
    if (exposure > 0.4) {
      return { ok: false, reason: `CONCENTRATION_${(exposure * 100).toFixed(0)}%_in_${tokenKey}` };
    }
    return { ok: true };
  }

  async simulate(userId: string, scenarioUsd: number): Promise<{ currentDayUsed: number; afterTrade: number; headroom: number; killSwitch: boolean; concentrationTop: { token: string; pct: number }[] }> {
    const cfg = await this.config(userId);
    const since = new Date(Date.now() - 24 * 3600_000);
    const used = await this.prisma.trade.aggregate({
      _sum: { priceUsd: true },
      where: { userId, createdAt: { gte: since }, mode: 'LIVE' },
    });
    const currentDayUsed = used._sum.priceUsd ?? 0;
    const afterTrade = currentDayUsed + scenarioUsd;
    const headroom = cfg.dailyUsd - afterTrade;

    const trades = await this.prisma.trade.findMany({
      where: { userId, mode: 'LIVE' },
      select: { tokenOut: true, priceUsd: true },
    });
    const portfolio = new Map<string, number>();
    for (const t of trades) {
      const key = t.tokenOut.slice(0, 10);
      portfolio.set(key, (portfolio.get(key) ?? 0) + (t.priceUsd ?? 0));
    }
    const total = Array.from(portfolio.values()).reduce((s, v) => s + v, 0) || 1;
    const concentrationTop = Array.from(portfolio.entries())
      .map(([token, val]) => ({ token, pct: Math.round((val / total) * 100) }))
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 5);

    return { currentDayUsed, afterTrade, headroom, killSwitch: cfg.killSwitch, concentrationTop };
  }
}
