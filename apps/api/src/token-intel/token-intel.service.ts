import { Injectable } from '@nestjs/common';
import { Chain } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { GoPlusProvider } from './providers/goplus.provider';
import { RugCheckProvider } from './providers/rugcheck.provider';
import { ConvictionEngine } from './conviction.engine';

@Injectable()
export class TokenIntelService {
  constructor(
    private prisma: PrismaService,
    private goplus: GoPlusProvider,
    private rugcheck: RugCheckProvider,
    private conviction: ConvictionEngine,
  ) {}

  /** Paste-and-analyze: contract address → full intelligence card. */
  async analyze(chain: Chain, address: string) {
    const cached = await this.prisma.tokenIntel.findUnique({ where: { chain_address: { chain, address } } });
    if (cached && Date.now() - cached.updatedAt.getTime() < 60_000) return cached;

    const flags: string[] = [];
    let securityScore: number | null = null;
    let holderData: unknown = null;

    if (chain === 'EVM') {
      const sec = await this.goplus.tokenSecurity('1', address).catch(() => null);
      if (sec) {
        if (sec.is_honeypot === '1') flags.push('HONEYPOT');
        if (sec.hidden_owner === '1') flags.push('HIDDEN_OWNER');
        if (sec.is_proxy === '1') flags.push('PROXY');
        if (sec.buy_tax && Number(sec.buy_tax) > 0.1) flags.push('HIGH_BUY_TAX');
        securityScore = Math.max(0, 100 - flags.length * 25);
        holderData = { count: sec.holder_count, top10: sec.holders };
      }
    } else {
      const rep = await this.rugcheck.tokenReport(address).catch(() => null);
      if (rep) {
        if (rep.risks?.some((r: any) => r.name?.includes('Mint'))) flags.push('MINT_AUTHORITY');
        if (rep.risks?.some((r: any) => r.name?.includes('Freeze'))) flags.push('FREEZE_AUTHORITY');
        securityScore = rep.score ?? 50;
        holderData = { count: rep.totalHolders, top: rep.topHolders };
      }
    }

    const conviction = this.conviction.score({
      securityScore,
      holderQuality: 60,
      liquidityScore: 60,
      sentimentScore: 0,
      momentumScore: 0,
      riskFlags: flags,
    });

    return this.prisma.tokenIntel.upsert({
      where: { chain_address: { chain, address } },
      update: { securityScore, securityFlags: flags as any, convictionScore: conviction, holderData: holderData as any },
      create: { chain, address, securityScore, securityFlags: flags as any, convictionScore: conviction, holderData: holderData as any },
    });
  }
}
