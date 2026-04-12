import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ActionAllowlist, type Logger, type EventEmitter } from './action.allowlist.js';
import { AgentActionType, OrderSide, OrderType } from '../types/actions.js';
import { ActionBlockedError } from '../types/errors.js';
import { SecurityEventType } from '../types/events.js';

// ─── Test helpers ───────────────────────────────────────────────────────────

function createLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createEmitter(): EventEmitter {
  return {
    emit: vi.fn(),
  };
}

function validPlaceOrder(): Record<string, unknown> {
  return {
    type: AgentActionType.PlaceOrder,
    instrument: 'BTC-USDT',
    side: OrderSide.BUY,
    orderType: OrderType.LIMIT,
    quantity: 1.5,
    price: 50000,
    strategyId: 'strat-1',
    clientOrderId: '550e8400-e29b-41d4-a716-446655440000',
  };
}

function validCancelOrder(): Record<string, unknown> {
  return {
    type: AgentActionType.CancelOrder,
    clientOrderId: '550e8400-e29b-41d4-a716-446655440000',
    instrument: 'BTC-USDT',
    strategyId: 'strat-1',
  };
}

function validModifyOrder(): Record<string, unknown> {
  return {
    type: AgentActionType.ModifyOrder,
    clientOrderId: '550e8400-e29b-41d4-a716-446655440000',
    instrument: 'BTC-USDT',
    newQuantity: 2.0,
    strategyId: 'strat-1',
  };
}

function validClosePosition(): Record<string, unknown> {
  return {
    type: AgentActionType.ClosePosition,
    instrument: 'BTC-USDT',
    strategyId: 'strat-1',
  };
}

function validRequestHumanReview(): Record<string, unknown> {
  return {
    type: AgentActionType.RequestHumanReview,
    reason: 'Unusual market conditions',
    context: { volatility: 'extreme' },
    strategyId: 'strat-1',
  };
}

function validNoAction(): Record<string, unknown> {
  return {
    type: AgentActionType.NoAction,
    reason: 'No trading signal detected',
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('ActionAllowlist', () => {
  let logger: Logger;
  let emitter: EventEmitter;
  let allowlist: ActionAllowlist;

  beforeEach(() => {
    logger = createLogger();
    emitter = createEmitter();
    allowlist = new ActionAllowlist({ logger, emitter });
  });

  // ── PlaceOrder ──────────────────────────────────────────────────────────

  describe('PlaceOrder', () => {
    it('validates a valid PlaceOrder action', () => {
      const result = allowlist.validate(validPlaceOrder());
      expect(result.type).toBe(AgentActionType.PlaceOrder);
    });

    it('requires confirmation for PlaceOrder', () => {
      const action = allowlist.validate(validPlaceOrder());
      expect(allowlist.requiresConfirmation(action)).toBe(true);
    });

    it('rejects PlaceOrder with missing instrument', () => {
      const raw = validPlaceOrder();
      delete raw.instrument;
      expect(() => allowlist.validate(raw)).toThrow(ActionBlockedError);
    });

    it('rejects PlaceOrder with negative quantity', () => {
      const raw = validPlaceOrder();
      raw.quantity = -1;
      expect(() => allowlist.validate(raw)).toThrow(ActionBlockedError);
    });

    it('rejects PlaceOrder with invalid side', () => {
      const raw = validPlaceOrder();
      raw.side = 'HOLD';
      expect(() => allowlist.validate(raw)).toThrow(ActionBlockedError);
    });

    it('validates a MARKET order without price', () => {
      const raw = validPlaceOrder();
      raw.orderType = OrderType.MARKET;
      delete raw.price;
      const result = allowlist.validate(raw);
      expect(result.type).toBe(AgentActionType.PlaceOrder);
    });
  });

  // ── CancelOrder ─────────────────────────────────────────────────────────

  describe('CancelOrder', () => {
    it('validates a valid CancelOrder action', () => {
      const result = allowlist.validate(validCancelOrder());
      expect(result.type).toBe(AgentActionType.CancelOrder);
    });

    it('does not require confirmation for CancelOrder', () => {
      const action = allowlist.validate(validCancelOrder());
      expect(allowlist.requiresConfirmation(action)).toBe(false);
    });

    it('rejects CancelOrder with non-UUID clientOrderId', () => {
      const raw = validCancelOrder();
      raw.clientOrderId = 'not-a-uuid';
      expect(() => allowlist.validate(raw)).toThrow(ActionBlockedError);
    });
  });

  // ── ModifyOrder ─────────────────────────────────────────────────────────

  describe('ModifyOrder', () => {
    it('validates a valid ModifyOrder action', () => {
      const result = allowlist.validate(validModifyOrder());
      expect(result.type).toBe(AgentActionType.ModifyOrder);
    });

    it('requires confirmation for ModifyOrder', () => {
      const action = allowlist.validate(validModifyOrder());
      expect(allowlist.requiresConfirmation(action)).toBe(true);
    });

    it('rejects ModifyOrder with missing clientOrderId', () => {
      const raw = validModifyOrder();
      delete raw.clientOrderId;
      expect(() => allowlist.validate(raw)).toThrow(ActionBlockedError);
    });
  });

  // ── ClosePosition ───────────────────────────────────────────────────────

  describe('ClosePosition', () => {
    it('validates a valid ClosePosition action', () => {
      const result = allowlist.validate(validClosePosition());
      expect(result.type).toBe(AgentActionType.ClosePosition);
    });

    it('requires confirmation for ClosePosition', () => {
      const action = allowlist.validate(validClosePosition());
      expect(allowlist.requiresConfirmation(action)).toBe(true);
    });
  });

  // ── RequestHumanReview ──────────────────────────────────────────────────

  describe('RequestHumanReview', () => {
    it('validates a valid RequestHumanReview action', () => {
      const result = allowlist.validate(validRequestHumanReview());
      expect(result.type).toBe(AgentActionType.RequestHumanReview);
    });

    it('does not require confirmation for RequestHumanReview', () => {
      const action = allowlist.validate(validRequestHumanReview());
      expect(allowlist.requiresConfirmation(action)).toBe(false);
    });
  });

  // ── NoAction ────────────────────────────────────────────────────────────

  describe('NoAction', () => {
    it('validates a valid NoAction', () => {
      const result = allowlist.validate(validNoAction());
      expect(result.type).toBe(AgentActionType.NoAction);
    });

    it('does not require confirmation for NoAction', () => {
      const action = allowlist.validate(validNoAction());
      expect(allowlist.requiresConfirmation(action)).toBe(false);
    });
  });

  // ── Unknown action type ─────────────────────────────────────────────────

  describe('unknown action type', () => {
    it('throws ActionBlockedError for unknown type', () => {
      const raw = { type: 'SelfDestruct', payload: {} };
      expect(() => allowlist.validate(raw)).toThrow(ActionBlockedError);
    });

    it('emits ACTION_BLOCKED for unknown type', () => {
      const raw = { type: 'SelfDestruct', payload: {} };
      try {
        allowlist.validate(raw);
      } catch {
        // expected
      }
      expect(emitter.emit).toHaveBeenCalledWith(
        SecurityEventType.ACTION_BLOCKED,
        expect.objectContaining({
          actionType: 'SelfDestruct',
          violatedRule: 'action-allowlist',
        }),
      );
    });
  });

  // ── Malformed payloads ──────────────────────────────────────────────────

  describe('malformed payloads', () => {
    it('throws for null input', () => {
      expect(() => allowlist.validate(null)).toThrow(ActionBlockedError);
    });

    it('throws for undefined input', () => {
      expect(() => allowlist.validate(undefined)).toThrow(ActionBlockedError);
    });

    it('throws for string input', () => {
      expect(() => allowlist.validate('place an order')).toThrow(ActionBlockedError);
    });

    it('throws for number input', () => {
      expect(() => allowlist.validate(42)).toThrow(ActionBlockedError);
    });

    it('throws for object without type field', () => {
      expect(() => allowlist.validate({ instrument: 'BTC-USDT' })).toThrow(ActionBlockedError);
    });

    it('throws for empty object', () => {
      expect(() => allowlist.validate({})).toThrow(ActionBlockedError);
    });

    it('throws for array input', () => {
      expect(() => allowlist.validate([{ type: 'PlaceOrder' }])).toThrow(ActionBlockedError);
    });
  });
});
