import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ExecutionService } from '../execution/execution.service';
import { TokenIntelService } from '../token-intel/token-intel.service';
import { AgentsService } from '../agents/agents.service';
import { AnalyticsService } from '../analytics/analytics.service';

@Injectable()
export class ToolExecutorService {
  private readonly logger = new Logger(ToolExecutorService.name);

  constructor(
    private prisma: PrismaService,
    private execution: ExecutionService,
    private tokenIntel: TokenIntelService,
    private agents: AgentsService,
    private analytics: AnalyticsService,
  ) {}

  async execute(userId: string, toolName: string, args: Record<string, any>): Promise<string> {
    this.logger.log(`Tool call: ${toolName} for user=${userId}`);

    try {
      switch (toolName) {
        case 'execute_swap':
          return await this.executeSwap(userId, args);
        case 'analyze_token':
          return await this.analyzeToken(args);
        case 'place_order':
          return await this.placeOrder(userId, args);
        case 'list_agents':
          return await this.listAgents(userId);
        case 'manage_agent':
          return await this.manageAgent(userId, args);
        case 'set_price_alert':
          return await this.setPriceAlert(userId, args);
        case 'get_portfolio':
          return await this.getPortfolio(userId);
        case 'get_performance':
          return await this.getPerformance(userId);
        default:
          return JSON.stringify({ error: `Unknown tool: ${toolName}` });
      }
    } catch (err: any) {
      this.logger.error(`Tool ${toolName} failed: ${err.message}`);
      return JSON.stringify({ error: err.message });
    }
  }

  private async executeSwap(userId: string, args: Record<string, any>): Promise<string> {
    const wallet = await this.prisma.wallet.findFirst({
      where: { userId, chain: args.chain, isPrimary: true },
    });
    if (!wallet) {
      const any = await this.prisma.wallet.findFirst({ where: { userId, chain: args.chain } });
      if (!any) return JSON.stringify({ error: `No ${args.chain} wallet found. Create one first.` });
    }
    const w = wallet ?? await this.prisma.wallet.findFirst({ where: { userId, chain: args.chain } });

    const result = await this.execution.swap({
      userId,
      walletId: w!.id,
      chain: args.chain,
      tokenIn: args.tokenIn,
      tokenOut: args.tokenOut,
      amountIn: args.amountIn,
      notionalUsd: args.notionalUsd ?? 0,
      slippageBps: args.slippageBps ?? 150,
    });

    return JSON.stringify({
      success: true,
      tradeId: result.tradeId,
      txHash: result.txHash,
      amountOut: result.amountOut,
      mode: result.mode,
    });
  }

  private async analyzeToken(args: Record<string, any>): Promise<string> {
    const result = await this.tokenIntel.analyze(args.chain, args.address);
    return JSON.stringify(result);
  }

  private async placeOrder(userId: string, args: Record<string, any>): Promise<string> {
    const wallet = await this.prisma.wallet.findFirst({
      where: { userId, chain: args.chain },
    });
    if (!wallet) return JSON.stringify({ error: `No ${args.chain} wallet found.` });

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
      },
    });

    return JSON.stringify({
      success: true,
      orderId: order.id,
      type: args.type,
      status: 'ACTIVE',
    });
  }

  private async listAgents(userId: string): Promise<string> {
    const agents = await this.agents.list(userId);
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
      data: {
        userId,
        token: args.token,
        chain: args.chain,
        targetUsd: args.targetUsd,
        direction: args.direction,
      },
    });
    return JSON.stringify({ success: true, alertId: alert.id, token: args.token, targetUsd: args.targetUsd, direction: args.direction });
  }

  private async getPortfolio(userId: string): Promise<string> {
    const wallets = await this.prisma.wallet.findMany({
      where: { userId },
      select: { id: true, chain: true, address: true, isPrimary: true },
    });
    return JSON.stringify({ wallets, count: wallets.length });
  }

  private async getPerformance(userId: string): Promise<string> {
    const perf = await this.analytics.performance(userId);
    return JSON.stringify(perf);
  }
}
