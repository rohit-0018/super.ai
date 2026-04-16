import { Logger } from '@nestjs/common';
import { OrderStatus, OrderType } from '@prisma/client';
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

const TRIGGER_TYPES: OrderType[] = [
  OrderType.STOP_LOSS,
  OrderType.TAKE_PROFIT,
  OrderType.TRAILING_STOP,
  OrderType.BRACKET,
  OrderType.LIMIT,
];

export function startPositionMonitorWorker(deps: WorkerDeps): Worker {
  const logger = new Logger('PositionMonitor');

  return makeWorker(QUEUES.POSITION_MONITOR, async () => {
    const orders = await deps.prisma.order.findMany({
      where: { status: { in: [OrderStatus.ACTIVE, OrderStatus.PENDING] }, type: { in: TRIGGER_TYPES } },
      take: 500,
    });

    let triggered = 0;
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
          payload: { orderId: order.id, type: order.type, price, reason: fire.reason },
        });
        triggered++;
      } catch (err: any) {
        logger.error(`order=${order.id} trigger failed: ${err.message}`);
      }
    }

    // G5: Liquidation defense — check for positions that dropped >80% from entry
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

    // H8: Price alert subscriptions
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

    logger.debug(`monitor tick: ${triggered} triggered / ${orders.length} scanned`);
    return { ok: true, triggered, scanned: orders.length };
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
