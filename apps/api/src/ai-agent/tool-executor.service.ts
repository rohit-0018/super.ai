import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ExecutionService } from '../execution/execution.service';
import { OrderManagerService } from '../execution/order-manager.service';
import { TokenIntelService } from '../token-intel/token-intel.service';
import { AgentsService } from '../agents/agents.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { GuardrailsService } from '../guardrails/guardrails.service';
import { MarketDataService } from '../market-data/market-data.service';

@Injectable()
export class ToolExecutorService {
  private readonly logger = new Logger(ToolExecutorService.name);

  constructor(
    private prisma: PrismaService,
    private execution: ExecutionService,
    private orderManager: OrderManagerService,
    private tokenIntel: TokenIntelService,
    private agents: AgentsService,
    private analytics: AnalyticsService,
    private guardrails: GuardrailsService,
    private marketData: MarketDataService,
  ) {}

  async execute(
    userId: string,
    toolName: string,
    args: Record<string, any>,
    channel: 'web' | 'telegram' | string = 'web',
  ): Promise<string> {
    this.logger.log(`Tool call: ${toolName} for user=${userId} channel=${channel}`);
    const source = channel === 'telegram' ? 'TELEGRAM' : 'CHAT';

    try {
      switch (toolName) {
        case 'execute_swap':
          return await this.executeSwap(userId, args, source);
        case 'analyze_token':
          return await this.analyzeToken(args);
        case 'place_order':
          return await this.placeOrder(userId, args, source);
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
        case 'list_orders':
          return await this.listOrders(userId, args);
        case 'cancel_order':
          return await this.cancelOrder(userId, args);
        case 'cancel_all_orders':
          return await this.cancelAllOrders(userId);
        case 'get_guardrails':
          return await this.getGuardrails(userId);
        case 'update_guardrails':
          return await this.updateGuardrails(userId, args);
        case 'kill_switch':
          return await this.activateKillSwitch(userId);
        case 'toggle_paper_mode':
          return await this.togglePaperMode(userId, args);
        case 'get_market_trending':
          return await this.getMarketTrending();
        case 'get_token_price':
          return await this.getTokenPrice(args);
        default:
          return JSON.stringify({ error: `Unknown tool: ${toolName}` });
      }
    } catch (err: any) {
      this.logger.error(`Tool ${toolName} failed: ${err.message}`);
      return JSON.stringify({ error: err.message });
    }
  }

  private async executeSwap(userId: string, args: Record<string, any>, source = 'CHAT'): Promise<string> {
    const wallet = await this.prisma.wallet.findFirst({
      where: { userId, chain: args.chain, isPrimary: true },
    });
    if (!wallet) {
      const any = await this.prisma.wallet.findFirst({ where: { userId, chain: args.chain } });
      if (!any) {
        return JSON.stringify({
          success: false,
          error: `No ${args.chain} wallet found. Create one first.`,
          chatMessage: `❌ **Can't place that trade**\n\nYou don't have a \`${args.chain}\` wallet yet. Create one first from the Wallets tab, then try again.`,
        });
      }
    }
    const w = wallet ?? await this.prisma.wallet.findFirst({ where: { userId, chain: args.chain } });

    try {
      const result = await this.execution.swap({
        userId,
        walletId: w!.id,
        chain: args.chain,
        tokenIn: args.tokenIn,
        tokenOut: args.tokenOut,
        amountIn: args.amountIn,
        notionalUsd: args.notionalUsd ?? 0,
        slippageBps: args.slippageBps ?? 150,
        source,
      });

      return JSON.stringify({
        success: true,
        tradeId: result.tradeId,
        status: result.status,
        simulated: result.simulated,
        network: result.network,
        mode: result.mode,
        side: result.side,
        txHash: result.txHash,
        explorerUrl: result.explorerUrl,
        amountOut: result.amountOut,
        // The pre-formatted markdown message — use this verbatim in chat.
        chatMessage: result.message,
      });
    } catch (err: any) {
      // Pull the structured failure body that ExecutionService throws
      // via BadGatewayException — the chatMessage is already formatted.
      const body = err?.response ?? {};
      return JSON.stringify({
        success: false,
        error: body.reason ?? err?.message ?? 'unknown',
        reason: body.reason,
        chatMessage: body.chatMessage ?? `❌ **Swap failed**\n\n\`${err?.message ?? 'unknown error'}\``,
      });
    }
  }

  private async analyzeToken(args: Record<string, any>): Promise<string> {
    const result = await this.tokenIntel.analyze(args.chain, args.address);
    return JSON.stringify(result);
  }

  private async placeOrder(userId: string, args: Record<string, any>, source = 'CHAT'): Promise<string> {
    const wallet = await this.prisma.wallet.findFirst({
      where: { userId, chain: args.chain },
    });
    if (!wallet) return JSON.stringify({ error: `No ${args.chain} wallet found.` });

    // DCA / interval orders are scheduled, not one-shot.
    const effectiveSource = args.interval ? 'SCHEDULED' : (args.type === 'DCA' ? 'DCA' : source);

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
        source: effectiveSource,
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

  // ─── Order management ───────────────────────────────────────────────

  private async listOrders(userId: string, args: Record<string, any>): Promise<string> {
    const orders = await this.orderManager.list(userId);
    const filtered = args.status
      ? orders.filter((o) => o.status === args.status)
      : orders;
    return JSON.stringify({
      orders: filtered.map((o) => ({
        id: o.id,
        type: o.type,
        status: o.status,
        chain: o.chain,
        tokenIn: o.tokenIn,
        tokenOut: o.tokenOut,
        amountIn: o.amountIn,
        source: o.source,
        createdAt: o.createdAt,
      })),
      total: filtered.length,
    });
  }

  private async cancelOrder(userId: string, args: Record<string, any>): Promise<string> {
    const { orderId } = args;
    const result = await this.orderManager.cancel(userId, orderId);
    if (result.count === 0) {
      return JSON.stringify({
        success: false,
        error: 'Order not found or already cancelled',
        chatMessage: `❌ **Could not cancel order**\n\nOrder \`${orderId}\` was not found or is already cancelled/filled.`,
      });
    }
    return JSON.stringify({
      success: true,
      orderId,
      chatMessage: `✅ **Order cancelled**\n\nOrder \`${orderId}\` has been cancelled successfully.`,
    });
  }

  private async cancelAllOrders(userId: string): Promise<string> {
    const orders = await this.orderManager.list(userId);
    const openOrders = orders.filter((o) => o.status === 'PENDING' || o.status === 'ACTIVE');

    if (openOrders.length === 0) {
      return JSON.stringify({
        success: true,
        cancelled: 0,
        chatMessage: '📝 **No open orders to cancel**\n\nYou have no pending or active orders.',
      });
    }

    let cancelled = 0;
    for (const order of openOrders) {
      const result = await this.orderManager.cancel(userId, order.id);
      if (result.count > 0) cancelled++;
    }

    return JSON.stringify({
      success: true,
      cancelled,
      total: openOrders.length,
      chatMessage: `✅ **All orders cancelled**\n\nCancelled **${cancelled}** open order${cancelled !== 1 ? 's' : ''}. Your order book is now clear.`,
    });
  }

  // ─── Guardrails & settings ─────────────────────────────────────────

  private async getGuardrails(userId: string): Promise<string> {
    const cfg = await this.guardrails.config(userId);
    return JSON.stringify({
      perTradeUsd: cfg.perTradeUsd,
      dailyUsd: cfg.dailyUsd,
      maxSlippageBps: cfg.maxSlippageBps,
      killSwitch: cfg.killSwitch,
      whitelist: cfg.whitelist,
      blacklist: cfg.blacklist,
    });
  }

  private async updateGuardrails(userId: string, args: Record<string, any>): Promise<string> {
    const patch: Record<string, any> = {};
    if (args.perTradeUsd !== undefined) patch.perTradeUsd = args.perTradeUsd;
    if (args.dailyUsd !== undefined) patch.dailyUsd = args.dailyUsd;
    if (args.maxSlippageBps !== undefined) patch.maxSlippageBps = args.maxSlippageBps;
    if (args.killSwitch !== undefined) patch.killSwitch = args.killSwitch;

    if (Object.keys(patch).length === 0) {
      return JSON.stringify({ success: false, error: 'No fields to update' });
    }

    const updated = await this.guardrails.update(userId, patch);
    const changes = Object.entries(patch)
      .map(([k, v]) => `- **${k}**: ${v}`)
      .join('\n');

    return JSON.stringify({
      success: true,
      config: {
        perTradeUsd: updated.perTradeUsd,
        dailyUsd: updated.dailyUsd,
        maxSlippageBps: updated.maxSlippageBps,
        killSwitch: updated.killSwitch,
      },
      chatMessage: `✅ **Guardrails updated**\n\n${changes}`,
    });
  }

  private async activateKillSwitch(userId: string): Promise<string> {
    await this.guardrails.kill(userId);
    return JSON.stringify({
      success: true,
      chatMessage: '🚨 **Kill switch activated**\n\nAll trading is now **blocked**. No orders or swaps will execute until you deactivate it.\n\nTo resume trading, update guardrails with `killSwitch: false`.',
    });
  }

  private async togglePaperMode(userId: string, args: Record<string, any>): Promise<string> {
    const { paperMode } = args;
    await this.prisma.user.update({
      where: { id: userId },
      data: { paperMode },
    });
    const mode = paperMode ? 'Paper' : 'Live';
    return JSON.stringify({
      success: true,
      paperMode,
      chatMessage: `✅ **Switched to ${mode} mode**\n\n${
        paperMode
          ? 'Trades are now simulated — no real funds at risk.'
          : '⚠️ **Live mode active** — trades use real funds. Make sure your guardrails are configured.'
      }`,
    });
  }

  // ─── Market data ────────────────────────────────────────────────────

  private async getMarketTrending(): Promise<string> {
    const [trending, movers] = await Promise.all([
      this.marketData.trending().catch(() => []),
      this.marketData.topMovers().catch(() => []),
    ]);
    return JSON.stringify({ trending, topMovers: movers });
  }

  private async getTokenPrice(args: Record<string, any>): Promise<string> {
    const price = await this.marketData.price(args.tokenId);
    return JSON.stringify({ tokenId: args.tokenId, priceUsd: price });
  }
}
