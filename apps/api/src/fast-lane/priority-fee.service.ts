import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ComputeBudgetProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import { ParallelRpcClient } from './parallel-rpc.client';

interface CachedFees {
  microLamports: number;
  computeUnitLimit: number;
  expiresAt: number;
}

@Injectable()
export class PriorityFeeService {
  private readonly logger = new Logger(PriorityFeeService.name);
  private readonly autoTune: boolean;
  private readonly manualFee: number;
  private readonly computeUnitLimit: number;
  private cache: CachedFees | null = null;
  private readonly cacheTtlMs = 5000; // 5s cache

  constructor(
    private config: ConfigService,
    private rpc: ParallelRpcClient,
  ) {
    this.autoTune =
      config.get<string>('FAST_LANE_PRIORITY_FEE_AUTO_TUNE', 'true') === 'true';
    this.manualFee = parseInt(
      config.get<string>('FAST_LANE_PRIORITY_FEE_MICROLAMPORTS', '50000'),
      10,
    );
    this.computeUnitLimit = parseInt(
      config.get<string>('FAST_LANE_COMPUTE_UNIT_LIMIT', '300000'),
      10,
    );
  }

  /**
   * Compute the priority fee (microLamports per compute unit) for the next tx.
   * Uses p99 of recent fees for fast lane (maximum priority).
   * Caches for 5s to avoid thrashing RPC.
   */
  async getFeeMicroLamports(
    percentile: 'p50' | 'p75' | 'p99' = 'p99',
  ): Promise<number> {
    if (!this.autoTune) {
      return this.manualFee;
    }

    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) {
      return this.cache.microLamports;
    }

    try {
      const conn = this.rpc.primaryConnection();
      // getRecentPrioritizationFees returns recent fees across recent slots
      const fees = await conn.getRecentPrioritizationFees();
      if (fees.length === 0) {
        return this.manualFee;
      }

      const values = fees
        .map((f) => f.prioritizationFee)
        .sort((a, b) => a - b);
      let selected: number;
      switch (percentile) {
        case 'p50':
          selected = values[Math.floor(values.length * 0.5)] ?? this.manualFee;
          break;
        case 'p75':
          selected = values[Math.floor(values.length * 0.75)] ?? this.manualFee;
          break;
        case 'p99':
        default:
          selected =
            values[Math.floor(values.length * 0.99)] ??
            values[values.length - 1] ??
            this.manualFee;
          break;
      }

      // Floor at manualFee, cap at 10x manual to prevent insane fees
      selected = Math.max(this.manualFee, Math.min(selected, this.manualFee * 10));

      this.cache = {
        microLamports: selected,
        computeUnitLimit: this.computeUnitLimit,
        expiresAt: now + this.cacheTtlMs,
      };

      this.logger.debug(
        `Priority fee auto-tuned: ${selected} microLamports (percentile=${percentile}, samples=${fees.length})`,
      );
      return selected;
    } catch (err: any) {
      this.logger.warn(
        `Priority fee auto-tune failed, using manual: ${err.message}`,
      );
      return this.manualFee;
    }
  }

  getComputeUnitLimit(): number {
    return this.computeUnitLimit;
  }

  /** Build the two compute budget instructions for a fast lane tx */
  async buildComputeBudgetInstructions(
    percentile: 'p50' | 'p75' | 'p99' = 'p99',
  ): Promise<TransactionInstruction[]> {
    const microLamports = await this.getFeeMicroLamports(percentile);
    return [
      ComputeBudgetProgram.setComputeUnitLimit({ units: this.computeUnitLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
    ];
  }
}
