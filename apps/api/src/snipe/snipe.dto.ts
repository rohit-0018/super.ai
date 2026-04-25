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
