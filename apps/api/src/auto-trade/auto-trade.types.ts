import type { AutoPosition, AutoTrade, AutoPortfolio } from '@prisma/client';

export type { AutoPosition, AutoTrade, AutoPortfolio };

/** Inputs to open an auto-trade position. Strategy-derived exits computed
 *  from these unless the user has overrides in their portfolio config. */
export interface OpenAutoPositionInput {
  userId: string;
  tokenAddress: string;
  symbol?: string | null;
  name?: string | null;
  chain?: 'SOLANA' | 'EVM';
  profileKey: string;
  source?: string; // 'auto_picker' | 'manual'
  entryPriceUsd: number;
  sizeUsd: number;
  /** Snapshot at entry — captured so retro analysis can show why we entered. */
  scoreAtEntry: number;
  verdictAtEntry: string;
  scoreBreakdown?: unknown;
  /** Explicit exit overrides — falls back to profile defaults if absent. */
  takeProfit1Pct?: number;
  takeProfit2Pct?: number;
  stopLossPct?: number;
  maxHoldMinutes?: number;
}

/** Outcome of a close decision — what reason fired, at what price. */
export interface CloseDecision {
  reason: 'TP1' | 'TP2' | 'STOP_LOSS' | 'MAX_HOLD' | 'MANUAL' | 'RUG';
  exitPriceUsd: number;
}
