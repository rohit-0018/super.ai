import { z } from 'zod';

// ─── Enums ───────────────────────────────────────────────────────────────────

export enum CircuitBreakerState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

// ─── Zod enum schema ─────────────────────────────────────────────────────────

export const CircuitBreakerStateSchema = z.nativeEnum(CircuitBreakerState);

// ─── Circuit Breaker Snapshot ────────────────────────────────────────────────

export const CircuitBreakerSnapshotSchema = z.object({
  name: z.string().min(1).describe('Unique name identifying this circuit breaker'),
  state: CircuitBreakerStateSchema.describe('Current state of the circuit breaker'),
  threshold: z.number().int().positive().describe('Number of failures before the breaker opens'),
  currentCount: z.number().int().nonnegative().describe('Current failure count'),
  lastStateChange: z.string().datetime().describe('ISO-8601 timestamp of the last state transition'),
});

export type CircuitBreakerSnapshot = z.infer<typeof CircuitBreakerSnapshotSchema>;

// ─── Position Snapshot ───────────────────────────────────────────────────────

export const PositionSnapshotSchema = z.object({
  instrument: z.string().min(1).describe('Trading instrument symbol (e.g., BTC-USDT)'),
  quantity: z.number().describe('Current position quantity (negative for short positions)'),
  averageEntryPrice: z.number().nonnegative().describe('Volume-weighted average entry price'),
  currentPrice: z.number().nonnegative().describe('Latest market price for this instrument'),
  unrealizedPnl: z.number().describe('Unrealized profit/loss in quote currency'),
  notionalValue: z.number().nonnegative().describe('Absolute notional value of the position (|quantity| * currentPrice)'),
});

export type PositionSnapshot = z.infer<typeof PositionSnapshotSchema>;

// ─── Portfolio Snapshot ──────────────────────────────────────────────────────

export const PortfolioSnapshotSchema = z.object({
  positions: z.array(PositionSnapshotSchema).describe('All current open positions'),
  totalNotional: z.number().nonnegative().describe('Sum of notional values across all positions'),
  totalUnrealizedPnl: z.number().describe('Sum of unrealized PnL across all positions'),
  drawdownFromHighWatermarkPercent: z.number().describe('Current drawdown from the portfolio high watermark, as a percentage (0-100)'),
});

export type PortfolioSnapshot = z.infer<typeof PortfolioSnapshotSchema>;
