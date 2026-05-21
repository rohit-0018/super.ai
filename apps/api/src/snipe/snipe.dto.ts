import { IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

export class UpsertSnipeConfigDto {
  @IsBoolean()
  enabled!: boolean;

  @IsIn(['SOLANA', 'EVM'])
  chain!: 'SOLANA' | 'EVM';

  @IsString()
  walletId!: string;

  /** Amount to spend per snipe. Lamports for Solana (e.g. "100000000" = 0.1 SOL). */
  @IsString()
  buyAmountRaw!: string;

  @IsInt() @Min(100) @Max(9000)
  maxSlippageBps!: number;

  /** Array of Telegram chat IDs (numeric strings like "-1001234567890"). */
  @IsArray() @IsString({ each: true })
  groupIds!: string[];

  @IsBoolean()
  skipSafety!: boolean;

  @IsInt() @Min(1000) @Max(300_000)
  dedupeWindowMs!: number;

  @IsBoolean()
  notifyOnBuy!: boolean;

  @IsOptional() @IsString()
  matchPattern?: string;

  // Sell config
  @IsBoolean()
  sellEnabled!: boolean;

  @IsIn(['TRIGGER', 'INTELLIGENT'])
  sellMode!: 'TRIGGER' | 'INTELLIGENT';

  @IsOptional() @IsNumber()
  takeProfitPct?: number;

  @IsOptional() @IsNumber()
  stopLossPct?: number;

  @IsOptional() @IsNumber()
  trailingStopPct?: number;

  @IsOptional() @IsInt() @Min(0)
  exitAfterMs?: number;

  @IsOptional() @IsNumber() @Min(1) @Max(99)
  partialExitPct?: number;
}

export class StartSessionDto {
  @IsString()
  walletId!: string;
}

/** Body for POST /api/snipe/burst — fire a parallel buy across every wallet. */
export class BurstSnipeDto {
  /** Solana mint to buy. */
  @IsString()
  mint!: string;

  /** Lamports per wallet (e.g. "100000000" = 0.1 SOL each). */
  @IsString()
  buyAmountRaw!: string;

  /**
   * Slippage cap in bps. Burst mode is meant for fast new-launch sniping so
   * we allow up to 50% (5000 bps). Above the normal tg-snipe ceiling of 9000
   * because the retry path escalates beyond this anyway.
   */
  @IsInt() @Min(100) @Max(5000)
  maxSlippageBps!: number;

  /** Pause heavy background workers for the burst window. Default true. */
  @IsOptional() @IsBoolean()
  pauseWorkers?: boolean;
}

export class UpsertGroupOverrideDto {
  @IsString()
  groupId!: string;

  @IsString()
  groupTitle!: string;

  @IsBoolean()
  enabled!: boolean;

  @IsOptional() @IsString()
  buyAmountRaw?: string;

  @IsOptional() @IsInt() @Min(100) @Max(9000)
  maxSlippageBps?: number;

  @IsOptional() @IsIn(['TRIGGER', 'INTELLIGENT'])
  sellMode?: 'TRIGGER' | 'INTELLIGENT';

  @IsOptional() @IsNumber()
  takeProfitPct?: number;

  @IsOptional() @IsNumber()
  stopLossPct?: number;

  @IsOptional() @IsNumber()
  trailingStopPct?: number;

  @IsOptional() @IsInt() @Min(0)
  exitAfterMs?: number;

  @IsOptional() @IsString()
  matchPattern?: string;
}
