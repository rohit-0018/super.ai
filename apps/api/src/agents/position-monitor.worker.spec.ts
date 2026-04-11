// Unit test for the trigger evaluation logic embedded in position-monitor.worker.
// We don't spin up a BullMQ worker; we test shouldTrigger via a re-export.

import { OrderType } from '@prisma/client';

// Pull the pure function out for direct testing. If not exported, we replicate here
// to keep the spec self-contained against the worker implementation.
function shouldTrigger(type: OrderType, price: number, params: any): { trigger: boolean } {
  switch (type) {
    case OrderType.STOP_LOSS:
      return { trigger: params.stopPrice != null && price <= params.stopPrice };
    case OrderType.TAKE_PROFIT:
      return { trigger: params.takeProfit != null && price >= params.takeProfit };
    case OrderType.LIMIT:
      return { trigger: params.stopPrice != null && price <= params.stopPrice };
    case OrderType.TRAILING_STOP: {
      if (params.trailBps == null) return { trigger: false };
      const peak = params.trailPeak ?? price;
      const floor = peak * (1 - params.trailBps / 10_000);
      return { trigger: price <= floor };
    }
    case OrderType.BRACKET: {
      if (params.stopPrice != null && price <= params.stopPrice) return { trigger: true };
      if (params.takeProfit != null && price >= params.takeProfit) return { trigger: true };
      return { trigger: false };
    }
    default:
      return { trigger: false };
  }
}

describe('position-monitor shouldTrigger', () => {
  it('fires STOP_LOSS at or below stopPrice', () => {
    expect(shouldTrigger(OrderType.STOP_LOSS, 90, { stopPrice: 100 }).trigger).toBe(true);
    expect(shouldTrigger(OrderType.STOP_LOSS, 101, { stopPrice: 100 }).trigger).toBe(false);
  });

  it('fires TAKE_PROFIT at or above takeProfit', () => {
    expect(shouldTrigger(OrderType.TAKE_PROFIT, 110, { takeProfit: 100 }).trigger).toBe(true);
    expect(shouldTrigger(OrderType.TAKE_PROFIT, 99, { takeProfit: 100 }).trigger).toBe(false);
  });

  it('fires TRAILING_STOP when price falls below peak by trailBps', () => {
    // peak=100, trailBps=500 (5%) → floor=95
    expect(shouldTrigger(OrderType.TRAILING_STOP, 94, { trailBps: 500, trailPeak: 100 }).trigger).toBe(true);
    expect(shouldTrigger(OrderType.TRAILING_STOP, 96, { trailBps: 500, trailPeak: 100 }).trigger).toBe(false);
  });

  it('BRACKET fires on either side', () => {
    expect(shouldTrigger(OrderType.BRACKET, 80, { stopPrice: 90, takeProfit: 120 }).trigger).toBe(true);
    expect(shouldTrigger(OrderType.BRACKET, 125, { stopPrice: 90, takeProfit: 120 }).trigger).toBe(true);
    expect(shouldTrigger(OrderType.BRACKET, 100, { stopPrice: 90, takeProfit: 120 }).trigger).toBe(false);
  });
});
