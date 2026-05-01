import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ExecutionService } from '../execution/execution.service';
import { TokenIntelService } from '../token-intel/token-intel.service';
import { TokenAnalysisService } from '../token-analysis/token-analysis.service';
import { AgentsService } from '../agents/agents.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { WalletsService } from '../wallets/wallets.service';
import { HotTokensService } from '../hot-tokens/hot-tokens.service';
import { TradingDnaService } from './trading-dna.service';
import { currentTraceId } from '../common/trace-context';
import type { TokenAnalysisReport, AiReasoning } from '../token-analysis/token-analysis.types';
import type { TradingProfile, ReportDepth } from '../token-analysis/profile.config';
import type { TradingStrategy } from '../token-analysis/trading-strategy.engine';

@Injectable()
export class ToolExecutorService {
  private readonly logger = new Logger(ToolExecutorService.name);

  constructor(
    private prisma: PrismaService,
    private execution: ExecutionService,
    private tokenIntel: TokenIntelService,
    private agents: AgentsService,
    private analytics: AnalyticsService,
    private wallets: WalletsService,
    private dna: TradingDnaService,
    private moduleRef: ModuleRef,
  ) {}

  // Lazy resolution avoids TokenAnalysisModule → TokenIntelModule → AiAgentModule cycle
  private getTokenAnalysis(): TokenAnalysisService {
    return this.moduleRef.get(TokenAnalysisService, { strict: false });
  }

  private hotTokensSvc(): HotTokensService {
    return this.moduleRef.get(HotTokensService, { strict: false });
  }

  async execute(userId: string, toolName: string, args: Record<string, any>): Promise<string> {
    const trace: string | undefined = currentTraceId();
    this.logger.log(`[trc=${trace ?? 'none'}] Tool call: ${toolName} for user=${userId}`);

    try {
      switch (toolName) {
        // ── Trading ──────────────────────────────────────────────────────────
        case 'execute_swap':     return await this.executeSwap(userId, args);
        case 'place_order':      return await this.placeOrder(userId, args);

        // ── Token Intelligence ────────────────────────────────────────────────
        case 'analyze_token':      return await this.analyzeToken(args);
        case 'analyze_token_full': return await this.analyzeTokenFull(args);
        case 'get_hot_tokens':     return await this.getHotTokens(args);

        // ── Portfolio & Balances ──────────────────────────────────────────────
        case 'get_balances':      return await this.getBalances(userId);
        case 'get_holdings':      return await this.getHoldings(userId);
        case 'get_portfolio':     return await this.getPortfolio(userId);
        case 'get_trade_history': return await this.getTradeHistory(userId, args);
        case 'get_performance':   return await this.getPerformance(userId);

        // ── User Settings ─────────────────────────────────────────────────────
        case 'get_user_info':  return await this.getUserInfo(userId);
        case 'set_paper_mode': return await this.setPaperMode(userId, args);

        // ── Agents & Alerts ───────────────────────────────────────────────────
        case 'list_agents':    return await this.listAgents(userId);
        case 'manage_agent':   return await this.manageAgent(userId, args);
        case 'set_price_alert': return await this.setPriceAlert(userId, args);

        default:
          return JSON.stringify({ error: `Unknown tool: ${toolName}` });
      }
    } catch (err: any) {
      this.logger.error(`[trc=${trace ?? 'none'}] Tool ${toolName} failed: ${err.message}`);
      return JSON.stringify({ error: err.message, traceId: trace });
    }
  }

  /* ── Trading ─────────────────────────────────────────────────────────────── */

  private async executeSwap(userId: string, args: Record<string, any>): Promise<string> {
    const wallet = await this.prisma.wallet.findFirst({
      where: { userId, chain: args.chain, isPrimary: true },
    }) ?? await this.prisma.wallet.findFirst({ where: { userId, chain: args.chain } });

    if (!wallet) return JSON.stringify({ error: `No ${args.chain} wallet found. Create one first.` });

    const trace: string | undefined = currentTraceId();
    const result = await this.execution.swap({
      userId,
      walletId: wallet.id,
      chain: args.chain,
      tokenIn: args.tokenIn,
      tokenOut: args.tokenOut,
      amountIn: args.amountIn,
      notionalUsd: args.notionalUsd ?? 0,
      slippageBps: args.slippageBps ?? 150,
      traceId: trace,
    });

    return JSON.stringify({
      success: true,
      tradeId: result.tradeId,
      txHash: result.txHash,
      amountOut: result.amountOut,
      mode: result.mode,
      traceId: result.traceId ?? trace,
    });
  }

  private async placeOrder(userId: string, args: Record<string, any>): Promise<string> {
    const wallet = await this.prisma.wallet.findFirst({ where: { userId, chain: args.chain } });
    if (!wallet) return JSON.stringify({ error: `No ${args.chain} wallet found.` });

    const trace: string | undefined = currentTraceId();
    const order = await this.prisma.order.create({
      data: {
        userId,
        walletId: wallet.id,
        type: args.type,
        chain: args.chain,
        tokenIn: args.tokenIn,
        tokenOut: args.tokenOut,
        amountIn: args.amountIn,
        status: 'ACTIVE',
        params: {
          stopPrice: args.triggerPrice,
          takeProfit: args.takeProfit,
          stopLoss: args.stopLoss,
          trailBps: args.trailingPct ? args.trailingPct * 100 : undefined,
          interval: args.interval,
        },
        ...(trace ? { traceId: trace } : {}),
      } as unknown as Prisma.OrderCreateInput,
    });

    await this.prisma.auditLog.create({
      data: {
        userId, action: 'tool.place_order', target: order.id,
        payload: { type: args.type, tokenIn: args.tokenIn, tokenOut: args.tokenOut, traceId: trace } as unknown as Prisma.InputJsonValue,
        ...(trace ? { traceId: trace } : {}),
      } as unknown as Prisma.AuditLogCreateInput,
    });

    return JSON.stringify({ success: true, orderId: order.id, type: args.type, status: 'ACTIVE' });
  }

  /* ── Token Intelligence ──────────────────────────────────────────────────── */

  private async analyzeToken(args: Record<string, any>): Promise<string> {
    const result = await this.tokenIntel.analyze(args.chain, args.address);
    return JSON.stringify(result);
  }

  private async analyzeTokenFull(args: Record<string, any>): Promise<string> {
    const profile = (args.profile ?? 'alpha_hunt') as TradingProfile;
    const depth = (args.depth ?? 'alpha') as ReportDepth;

    const report = await this.getTokenAnalysis().analyzeWithProfile(
      args.address,
      profile,
      depth,
      false,
      null,
    );

    return this.formatAnalysisDigest(report);
  }

  private formatAnalysisDigest(report: TokenAnalysisReport): string {
    const m = report.meta;
    const ai: AiReasoning | undefined = report.aiReasoning;
    const ts: TradingStrategy | undefined = report.tradingStrategy;
    const lines: string[] = [];

    // ── Header ─────────────────────────────────────────────────────────────
    lines.push(`## ${m.symbol ?? 'UNKNOWN'} — ${m.name ?? ''}`);
    lines.push(`Chain: ${m.chain} | Price: $${m.priceUsd?.toFixed(6) ?? '?'} | 1h: ${m.priceChange?.h1?.toFixed(1) ?? '?'}% | 24h: ${m.priceChange?.h24?.toFixed(1) ?? '?'}%`);
    lines.push(`Vol 24h: $${fmtNum(m.volume24hUsd)} | Liquidity: $${fmtNum(m.liquidityUsd)} | Age: ${m.pairAgeHours?.toFixed(1) ?? '?'}h`);
    if (m.marketCapUsd) lines.push(`MCap: $${fmtNum(m.marketCapUsd)} | FDV: $${fmtNum(m.fdvUsd)}`);

    // ── Safety ──────────────────────────────────────────────────────────────
    const s = report.safety;
    if (s) {
      const danger: string[] = [];
      if (s.honeypot === 'yes') danger.push('HONEYPOT');
      if (s.mintAuthority) danger.push('mint authority');
      if (s.freezeAuthority) danger.push('freeze authority');
      if ((s.buyTax ?? 0) > 500) danger.push(`buy tax ${((s.buyTax ?? 0) / 100).toFixed(1)}%`);
      if ((s.sellTax ?? 0) > 500) danger.push(`sell tax ${((s.sellTax ?? 0) / 100).toFixed(1)}%`);
      if ((s.topHoldersPct ?? 0) > 50) danger.push(`top holders ${s.topHoldersPct?.toFixed(1)}%`);
      if (s.rugScore !== undefined && s.rugScore > 60) danger.push(`rug score ${s.rugScore}`);
      if (s.flags.length) danger.push(...s.flags.slice(0, 3));
      if (danger.length) lines.push(`⚠ Safety flags: ${danger.join(', ')}`);
      else lines.push(`✓ Safety: no critical flags`);
    }

    // ── AI Verdict ──────────────────────────────────────────────────────────
    if (ai) {
      lines.push(`\n**AI Verdict [${report.profile ?? 'unknown'}]**: ${ai.verdict} — Score ${ai.score}/100`);
      lines.push(`Scores → Safety:${ai.categoryScores.safety} Distribution:${ai.categoryScores.distribution} Market:${ai.categoryScores.market} Social:${ai.categoryScores.social} Macro:${ai.categoryScores.macro}`);
      if (ai.bullishSignals.length) lines.push(`Bulls: ${ai.bullishSignals.slice(0, 3).join(' · ')}`);
      if (ai.riskFactors.length) lines.push(`Risks: ${ai.riskFactors.slice(0, 3).join(' · ')}`);
      if (ai.summary) lines.push(`Summary: ${ai.summary.slice(0, 400)}`);
      if (ai.exitSizing) lines.push(`Exit sizing: ${ai.exitSizing}`);
    }

    // ── Smart Money ──────────────────────────────────────────────────────────
    const sm = report.smartMoney;
    if (sm?.holdersFound) {
      const labels = sm.holders.slice(0, 3).map(h => h.label).join(', ');
      lines.push(`\nSmart money: ${sm.holdersFound} known wallets holding — ${labels}`);
    }

    // ── Holder Metrics ───────────────────────────────────────────────────────
    const hm = report.holderMetrics;
    if (hm) {
      const hmParts: string[] = [];
      if (hm.totalHolders) hmParts.push(`${hm.totalHolders.toLocaleString()} holders`);
      if (hm.bundleDetected) hmParts.push('bundle launch detected');
      if (hm.organicScore !== undefined) hmParts.push(`organic score ${hm.organicScore}/100`);
      if (hm.lifecycle?.stage) hmParts.push(`stage: ${hm.lifecycle.stage}`);
      if (hmParts.length) lines.push(`Holders: ${hmParts.join(' | ')}`);
    }

    // ── Trading Strategy ─────────────────────────────────────────────────────
    if (ts) {
      lines.push(`\n**Strategy [${ts.profileLabel}]**:`);
      if (ts.entryZone) lines.push(`Entry zone: $${ts.entryZone.low.toFixed(6)} – $${ts.entryZone.high.toFixed(6)}`);
      else if (ts.entryPrice) lines.push(`Entry: $${ts.entryPrice.toFixed(6)}`);
      lines.push(`Stop-loss: $${ts.stopLossPrice?.toFixed(6) ?? 'n/a'} (−${ts.stopLossPct}%) — ${ts.stopLossNote}`);
      if (ts.targets.length) {
        const tgts = ts.targets.slice(0, 3).map(t => `${t.label} $${t.price?.toFixed(6) ?? 'n/a'} (+${t.pct.toFixed(0)}%)`).join(' | ');
        lines.push(`Targets: ${tgts}`);
      }
      lines.push(`Max hold: ${ts.maxHoldTime}`);
      if (ts.positionSizing) {
        lines.push(`Position size: ${ts.positionSizing.pctRange[0]}–${ts.positionSizing.pctRange[1]}% of portfolio`);
      }
    }

    return lines.join('\n');
  }

  private async getHotTokens(args: Record<string, any>): Promise<string> {
    const profile = (args.profile ?? 'meme_hunter') as string;
    return this.hotTokensSvc().getHotTokensForAgent(profile);
  }

  /* ── Portfolio & Balances ────────────────────────────────────────────────── */

  private async getBalances(userId: string): Promise<string> {
    const balances = await this.wallets.getAllBalances(userId);
    if (!balances.length) return 'No wallets found.';

    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { paperMode: true } });
    const lines = balances.map(b =>
      `${b.chain}: ${(b as any).native?.toFixed(4) ?? '?'} ${(b as any).symbol ?? ''} ≈ $${(b as any).usd?.toFixed(2) ?? '?'}`,
    );
    if (user?.paperMode) lines.unshift('[PAPER MODE — simulated balances]');
    return `Wallet Balances:\n${lines.join('\n')}`;
  }

  private async getHoldings(userId: string): Promise<string> {
    const wallet = await this.prisma.wallet.findFirst({ where: { userId, chain: 'SOLANA', isPrimary: true } })
      ?? await this.prisma.wallet.findFirst({ where: { userId, chain: 'SOLANA' } });

    if (!wallet) return 'No Solana wallet found. Holdings only available for Solana.';

    const holdings = await this.wallets.getHoldings(userId, wallet.id);
    if (!holdings.length) return 'No open positions in primary Solana wallet.';

    const lines = holdings.map(h => {
      const pnlSign = (h.pnlPct ?? 0) >= 0 ? '+' : '';
      return `${h.symbol}: ${h.amount.toFixed(4)} tokens | $${h.valueUsd?.toFixed(2) ?? '?'} | P&L: ${pnlSign}${h.pnlPct?.toFixed(1) ?? '?'}% ($${pnlSign}${h.pnlUsd?.toFixed(2) ?? '?'})`;
    });

    const totalValue = holdings.reduce((s, h) => s + (h.valueUsd ?? 0), 0);
    const totalPnl = holdings.reduce((s, h) => s + (h.pnlUsd ?? 0), 0);

    return [
      `Holdings (${holdings.length} positions | Total $${totalValue.toFixed(2)} | P&L ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}):`,
      ...lines,
    ].join('\n');
  }

  private async getPortfolio(userId: string): Promise<string> {
    const wallets = await this.prisma.wallet.findMany({
      where: { userId },
      select: { id: true, chain: true, address: true, label: true, isPrimary: true },
    });
    return JSON.stringify({ wallets, count: wallets.length });
  }

  private async getTradeHistory(userId: string, args: Record<string, any>): Promise<string> {
    const limit = Math.min(args.limit ?? 20, 50);
    const trades = await this.prisma.trade.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, tokenIn: true, tokenOut: true, amountIn: true, amountOut: true, priceUsd: true, mode: true, createdAt: true },
    });

    if (!trades.length) return 'No trade history found.';

    const lines = trades.map(t =>
      `${t.createdAt.toISOString().slice(0, 10)} | ${t.tokenIn} → ${t.tokenOut} | in:${t.amountIn} out:${t.amountOut ?? '?'} | $${t.priceUsd?.toFixed(4) ?? '?'} | ${t.mode}`,
    );
    return `Recent trades (${trades.length}):\n${lines.join('\n')}`;
  }

  private async getPerformance(userId: string): Promise<string> {
    const perf = await this.analytics.performance(userId);
    return JSON.stringify(perf);
  }

  /* ── User Settings ───────────────────────────────────────────────────────── */

  private async getUserInfo(userId: string): Promise<string> {
    const [user, agentCount] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { paperMode: true, email: true, createdAt: true },
      }),
      this.agents.list(userId).then(a => a.length).catch(() => 0),
    ]);

    const dnaStr = await this.dna.profileForPrompt(userId).catch(() => '{}');
    let dna: Record<string, any> = {};
    try { dna = JSON.parse(dnaStr); } catch {}

    let learningConfig: Record<string, any> | null = null;
    try {
      const lc = await (this.prisma as any).learningConfig.findUnique({ where: { userId } });
      if (lc) learningConfig = { enabled: lc.enabled, autonomyLevel: lc.autonomyLevel, maxTradeUsd: lc.maxTradeUsd, dailyLimit: lc.dailyLimit };
    } catch {}

    return JSON.stringify({
      paperMode: user?.paperMode ?? true,
      email: user?.email,
      activeAgents: agentCount,
      tradingDna: dna,
      learningConfig,
    });
  }

  private async setPaperMode(userId: string, args: Record<string, any>): Promise<string> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { paperMode: !!args.enabled },
    });
    const msg = args.enabled
      ? 'Switched to PAPER mode. All trades are now simulated with no real funds at risk.'
      : '⚠ Switched to LIVE mode. Trades will use real on-chain funds.';
    return JSON.stringify({ success: true, paperMode: !!args.enabled, message: msg });
  }

  /* ── Agents & Alerts ─────────────────────────────────────────────────────── */

  private async listAgents(userId: string): Promise<string> {
    const agents = await this.agents.list(userId);
    if (!agents.length) return 'No active agents.';
    return JSON.stringify(agents);
  }

  private async manageAgent(userId: string, args: Record<string, any>): Promise<string> {
    const { agentId, action } = args;
    if (action === 'pause') await this.agents.pause(userId, agentId);
    else if (action === 'resume') await this.agents.resume(userId, agentId);
    else if (action === 'kill') await this.agents.kill(userId, agentId);
    return JSON.stringify({ success: true, agentId, action });
  }

  private async setPriceAlert(userId: string, args: Record<string, any>): Promise<string> {
    const alert = await (this.prisma as any).priceAlert.create({
      data: { userId, token: args.token, chain: args.chain, targetUsd: args.targetUsd, direction: args.direction },
    });
    return JSON.stringify({ success: true, alertId: alert.id, token: args.token, targetUsd: args.targetUsd, direction: args.direction });
  }
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */
function fmtNum(n: number | undefined | null): string {
  if (n == null) return '?';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(2);
}
