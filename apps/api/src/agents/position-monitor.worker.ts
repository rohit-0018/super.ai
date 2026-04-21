import { Logger } from '@nestjs/common';
import { AgentKind, AgentStatus, OrderStatus, OrderType } from '@prisma/client';
import { Worker } from 'bullmq';
import { makeWorker, QUEUES } from './queues';
import type { WorkerDeps } from './worker.bootstrap';

interface TriggerParams {
  stopPrice?: number;
  takeProfit?: number;
  trailBps?: number;
  trailPeak?: number;
  slippageBps?: number;
}

interface MonitorAgentParams {
  walletId?: string;
  tokenIn?: string;
  tokenOut?: string;
  chain?: string;
  stopPrice?: number;
  slippageBps?: number;
}

const TRIGGER_TYPES: OrderType[] = [
  OrderType.STOP_LOSS,
  OrderType.TAKE_PROFIT,
  OrderType.TRAILING_STOP,
  OrderType.BRACKET,
  OrderType.LIMIT,
];

// Throttle scan events to avoid DB spam — key → last emit timestamp.
const scanThrottle = new Map<string, number>();

function shouldThrottledEmit(key: string, intervalMs = 5 * 60_000): boolean {
  const now = Date.now();
  if (!scanThrottle.has(key) || now - scanThrottle.get(key)! > intervalMs) {
    scanThrottle.set(key, now);
    return true;
  }
  return false;
}

export function startPositionMonitorWorker(deps: WorkerDeps): Worker {
  const logger = new Logger('PositionMonitor');

  return makeWorker(QUEUES.POSITION_MONITOR, async () => {
    let triggered = 0;

    // ───────────────────────────────────────────────────────────────
    // 1. Monitor Agent rows with kind=POSITION_MONITOR or STOP_LOSS
    // ───────────────────────────────────────────────────────────────
    const monitorAgents = await deps.prisma.agent.findMany({
      where: {
        status: AgentStatus.RUNNING,
        kind: { in: [AgentKind.POSITION_MONITOR, AgentKind.STOP_LOSS] },
      },
      take: 200,
    });

    for (const agent of monitorAgents) {
      const params = agent.params as unknown as MonitorAgentParams;
      if (!params?.tokenOut) continue;

      const price = await safePrice(deps, params.tokenOut);
      if (price == null) {
        // Still emit a heartbeat so user sees the agent is trying
        if (shouldThrottledEmit(`agent:${agent.id}:noprice`)) {
          await deps.notifications.emit({
            userId: agent.userId,
            kind: 'POSITION_SCAN',
            severity: 'INFO',
            payload: {
              agentId: agent.id,
              token: params.tokenOut,
              message: `Monitoring ${params.tokenOut.slice(0, 8)} — waiting for price data…`,
            },
          });
          await deps.prisma.agent.update({ where: { id: agent.id }, data: { lastRunAt: new Date() } });
        }
        continue;
      }

      // Update lastRunAt
      await deps.prisma.agent.update({ where: { id: agent.id }, data: { lastRunAt: new Date() } });

      // Check stop-loss trigger
      const stopTriggered = params.stopPrice != null && price <= params.stopPrice;

      // Emit scan event (throttled)
      if (shouldThrottledEmit(`agent:${agent.id}`)) {
        const distance = params.stopPrice != null
          ? ((price / params.stopPrice - 1) * 100).toFixed(1)
          : null;
        const status = stopTriggered
          ? `🚨 TRIGGERED — price $${price.toFixed(4)} hit stop $${params.stopPrice}`
          : distance != null
            ? `${distance}% above stop ($${params.stopPrice})`
            : 'watching';

        await deps.notifications.emit({
          userId: agent.userId,
          kind: 'POSITION_SCAN',
          severity: stopTriggered ? 'CRITICAL' : 'INFO',
          payload: {
            agentId: agent.id,
            token: params.tokenOut,
            currentPrice: price,
            stopPrice: params.stopPrice ?? null,
            distance: distance != null ? `${distance}%` : null,
            willTrigger: stopTriggered,
            message: `${params.tokenOut.slice(0, 8)} @ $${price.toFixed(4)} — ${status}`,
          },
        });
      }

      // Execute stop-loss if triggered
      if (stopTriggered && params.walletId) {
        try {
          await deps.execution.swap({
            userId: agent.userId,
            walletId: params.walletId,
            chain: (params.chain as any) ?? 'SOLANA',
            tokenIn: params.tokenOut,
            tokenOut: params.tokenIn ?? 'USDC',
            amountIn: '0', // sell all — execution service handles this
            notionalUsd: 0,
            slippageBps: params.slippageBps ?? 150,
            source: 'AGENT',
          });
          await deps.notifications.emit({
            userId: agent.userId,
            kind: 'STOP_LOSS_TRIGGERED',
            severity: 'WARN',
            payload: {
              agentId: agent.id,
              token: params.tokenOut,
              price,
              stopPrice: params.stopPrice,
              message: `Stop-loss triggered for ${params.tokenOut.slice(0, 8)} at $${price.toFixed(4)}. Position closed.`,
            },
          });
          // Kill the agent after it fires
          await deps.prisma.agent.update({ where: { id: agent.id }, data: { status: AgentStatus.KILLED } });
          triggered++;
        } catch (err: any) {
          logger.error(`agent=${agent.id} stop-loss execution failed: ${err.message}`);
          await deps.notifications.emit({
            userId: agent.userId,
            kind: 'AGENT_ERROR',
            severity: 'CRITICAL',
            payload: {
              agentId: agent.id,
              error: err.message,
              message: `Stop-loss execution failed for ${params.tokenOut.slice(0, 8)}: ${err.message}`,
            },
          });
        }
      }
    }

    // ───────────────────────────────────────────────────────────────
    // 2. Monitor Order rows (existing logic for trigger orders)
    // ───────────────────────────────────────────────────────────────
    const orders = await deps.prisma.order.findMany({
      where: { status: { in: [OrderStatus.ACTIVE, OrderStatus.PENDING] }, type: { in: TRIGGER_TYPES } },
      take: 500,
    });

    for (const order of orders) {
      const params = (order.params as unknown as TriggerParams) ?? {};
      const price = await safePrice(deps, order.tokenOut);
      if (price == null) continue;

      const fire = shouldTrigger(order.type, price, params);

      // Trailing stop: track peak price between ticks and update on ascent.
      if (order.type === OrderType.TRAILING_STOP && params.trailBps != null) {
        const peak = params.trailPeak ?? price;
        if (price > peak) {
          await deps.prisma.order.update({
            where: { id: order.id },
            data: { params: { ...params, trailPeak: price } as any },
          });
        }
      }

      // Emit scan event (throttled)
      if (shouldThrottledEmit(`order:${order.id}`)) {
        const distance = params.stopPrice != null
          ? `${((price / params.stopPrice - 1) * 100).toFixed(1)}% from trigger`
          : params.takeProfit != null
            ? `${((params.takeProfit / price - 1) * 100).toFixed(1)}% from target`
            : null;
        await deps.notifications.emit({
          userId: order.userId,
          kind: 'POSITION_SCAN',
          severity: 'INFO',
          payload: {
            orderId: order.id,
            agentId: order.id, // link to order ID for agent-log lookups
            type: order.type,
            token: order.tokenOut,
            currentPrice: price,
            triggerPrice: params.stopPrice ?? params.takeProfit ?? null,
            distance,
            willTrigger: fire.trigger,
            message: `Watching ${order.tokenOut.slice(0, 8)} @ $${price.toFixed(4)}${distance ? ` — ${distance}` : ''}`,
          },
        });
      }

      if (!fire.trigger) continue;

      try {
        await deps.execution.swap({
          userId: order.userId,
          walletId: order.walletId,
          chain: order.chain,
          tokenIn: order.tokenIn,
          tokenOut: order.tokenOut,
          amountIn: order.amountIn,
          notionalUsd: price * Number(order.amountIn) / 1e6,
          slippageBps: params.slippageBps ?? 150,
          orderId: order.id,
          source: 'AGENT',
        });
        await deps.notifications.emit({
          userId: order.userId,
          kind: 'ORDER_TRIGGERED',
          severity: 'WARN',
          payload: { orderId: order.id, agentId: order.id, type: order.type, price, reason: fire.reason },
        });
        triggered++;
      } catch (err: any) {
        logger.error(`order=${order.id} trigger failed: ${err.message}`);
      }
    }

    // ───────────────────────────────────────────────────────────────
    // 3. Liquidation defense — positions that dropped >80%
    // ───────────────────────────────────────────────────────────────
    const openTrades = await deps.prisma.trade.findMany({
      where: { userId: { not: undefined }, mode: 'LIVE' },
      orderBy: { createdAt: 'desc' },
      take: 200,
      distinct: ['tokenOut', 'userId'],
    });
    for (const t of openTrades) {
      const price = await safePrice(deps, t.tokenOut);
      if (price == null || !t.priceUsd || t.priceUsd <= 0) continue;
      const drawdown = 1 - price / t.priceUsd;
      if (drawdown >= 0.8) {
        await deps.notifications.emit({
          userId: t.userId,
          kind: 'LIQUIDATION_WARNING',
          severity: 'CRITICAL',
          payload: {
            token: t.tokenOut,
            entryPrice: t.priceUsd,
            currentPrice: price,
            drawdownPct: Math.round(drawdown * 100),
            message: `${t.tokenOut.slice(0, 8)} is down ${Math.round(drawdown * 100)}% from entry. Consider closing to prevent total loss.`,
          },
        });
      }
    }

    // ───────────────────────────────────────────────────────────────
    // 4. Price alert subscriptions
    // ───────────────────────────────────────────────────────────────
    const priceAlerts = await (deps.prisma as any).priceAlert.findMany({ where: { fired: false }, take: 200 });
    for (const pa of priceAlerts) {
      const p = await safePrice(deps, pa.token);
      if (p == null) continue;
      const hit = pa.direction === 'above' ? p >= pa.targetUsd : p <= pa.targetUsd;
      if (hit) {
        await deps.notifications.emit({
          userId: pa.userId,
          kind: 'PRICE_ALERT',
          severity: 'INFO',
          payload: {
            token: pa.token,
            direction: pa.direction,
            targetUsd: pa.targetUsd,
            currentPrice: p,
            message: `${pa.token.slice(0, 8)} hit $${p.toFixed(4)} (${pa.direction} $${pa.targetUsd})`,
          },
        });
        await (deps.prisma as any).priceAlert.update({ where: { id: pa.id }, data: { fired: true } });
      }
    }

    logger.debug(`monitor tick: ${triggered} triggered / ${orders.length} orders / ${monitorAgents.length} agents`);
    return { ok: true, triggered, scannedOrders: orders.length, scannedAgents: monitorAgents.length };
  });
}

function shouldTrigger(
  type: OrderType,
  price: number,
  params: TriggerParams,
): { trigger: boolean; reason?: string } {
  switch (type) {
    case OrderType.STOP_LOSS:
      return params.stopPrice != null && price <= params.stopPrice
        ? { trigger: true, reason: `price ${price} <= stop ${params.stopPrice}` }
        : { trigger: false };
    case OrderType.TAKE_PROFIT:
      return params.takeProfit != null && price >= params.takeProfit
        ? { trigger: true, reason: `price ${price} >= take ${params.takeProfit}` }
        : { trigger: false };
    case OrderType.LIMIT:
      return params.stopPrice != null && price <= params.stopPrice
        ? { trigger: true, reason: `limit ${params.stopPrice} reached` }
        : { trigger: false };
    case OrderType.TRAILING_STOP: {
      if (params.trailBps == null) return { trigger: false };
      const peak = params.trailPeak ?? price;
      const floor = peak * (1 - params.trailBps / 10_000);
      return price <= floor
        ? { trigger: true, reason: `trailing floor ${floor.toFixed(4)} breached` }
        : { trigger: false };
    }
    case OrderType.BRACKET: {
      if (params.stopPrice != null && price <= params.stopPrice) return { trigger: true, reason: 'bracket stop' };
      if (params.takeProfit != null && price >= params.takeProfit) return { trigger: true, reason: 'bracket take' };
      return { trigger: false };
    }
    default:
      return { trigger: false };
  }
}

async function safePrice(deps: WorkerDeps, token: string): Promise<number | null> {
  try {
    return await deps.marketData.price(token);
  } catch {
    return null;
  }
}
