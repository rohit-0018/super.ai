import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Connection } from '@solana/web3.js';
import { getSolanaRpcUrl, isTestnet } from '../common/network-config';

/**
 * Helius-specific optimizations for transaction speed and cost.
 *
 * Priority fee estimation:
 *   Helius's getPriorityFeeEstimate RPC method returns the current market rate
 *   at each percentile. We use the veryHigh estimate as the maxLamports cap sent
 *   to Jupiter — so we pay exactly what's needed for landing without over-paying.
 *
 * Connection strategy:
 *   - readConnection  (confirmed): getSignatureStatuses, getBalance — safe finality
 *   - sendConnection  (processed): sendRawTransaction — fastest acceptance
 *
 * The staked endpoint (staked.helius-rpc.com) provides higher landing rates by
 *   bypassing leader-scheduling queues. We derive it from the API key if present.
 */

const FEE_CACHE_TTL_MS = 2_000;        // priority fees change per block (~400 ms) — 2 s is safe
const ESTIMATE_TIMEOUT_MS = 1_500;     // advisory call, must not block tx path
const FALLBACK_VERY_HIGH_MICRO = 200_000; // microLamports/CU — safe default if Helius unavailable
const MAX_LAMPORTS_HARD_CAP = 5_000_000; // 0.005 SOL — upper limit regardless of estimate
const JUPITER_SWAP_CU_ESTIMATE = 200_000; // typical CU budget for a Jupiter versioned tx

interface FeeCache {
  veryHighMicroLamports: number;
  cachedAt: number;
}

@Injectable()
export class HeliusService implements OnModuleInit {
  private readonly logger = new Logger(HeliusService.name);

  private readonly rpcUrl: string;
  private readonly stakedUrl: string | null;
  private readonly apiKey: string | null;
  private feeCache: FeeCache | null = null;

  constructor() {
    this.rpcUrl = getSolanaRpcUrl();
    this.apiKey = this.extractApiKey(this.rpcUrl);
    this.stakedUrl = this.deriveStakedUrl(this.rpcUrl, this.apiKey);
  }

  onModuleInit() {
    if (this.apiKey) {
      this.logger.log(
        `Helius detected — priority fee estimation ON, staked URL: ${this.stakedUrl ?? 'n/a (standard plan)'}`,
      );
    } else {
      this.logger.warn('No Helius API key in HELIUS_RPC_URL — priority fee estimation disabled, using fallback');
    }
  }

  // ── Connection factories ───────────────────────────────────────────────────

  /** Confirmed commitment — use for getSignatureStatuses, getBalance. Safe finality. */
  makeReadConnection(): Connection {
    return new Connection(this.rpcUrl, {
      commitment: 'confirmed',
      disableRetryOnRateLimit: true,
      confirmTransactionInitialTimeout: 60_000,
      fetch: this.buildFetch(),
    });
  }

  /**
   * Processed commitment — use for sendRawTransaction only.
   * Routes through Helius staked infrastructure if available.
   * "processed" lets the RPC forward the tx without waiting for validator agreement.
   */
  makeSendConnection(): Connection {
    const url = this.stakedUrl ?? this.rpcUrl;
    return new Connection(url, {
      commitment: 'processed',
      disableRetryOnRateLimit: true,
      fetch: this.buildFetch(),
    });
  }

  // ── Priority fee estimation ────────────────────────────────────────────────

  /**
   * Returns the veryHigh priority fee estimate in microLamports/CU.
   * Cached for 2 s so we don't block the hot path.
   * Falls back to FALLBACK_VERY_HIGH_MICRO if Helius is unavailable.
   *
   * @param accountKeys  Optional writable accounts involved in the tx.
   *   Passing them gives a more accurate estimate for the specific program.
   */
  async getPriorityFeeEstimate(accountKeys: string[] = []): Promise<number> {
    if (isTestnet()) return 0;

    if (this.feeCache && Date.now() - this.feeCache.cachedAt < FEE_CACHE_TTL_MS) {
      return this.feeCache.veryHighMicroLamports;
    }

    if (!this.apiKey) return FALLBACK_VERY_HIGH_MICRO;

    try {
      const res = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'fee-estimate',
          method: 'getPriorityFeeEstimate',
          params: [{
            accountKeys: accountKeys.length ? accountKeys : undefined,
            options: { includeAllPriorityFeeLevels: true },
          }],
        }),
        signal: AbortSignal.timeout(ESTIMATE_TIMEOUT_MS),
      });

      if (res.ok) {
        const body = await res.json();
        const veryHigh = body?.result?.priorityFeeLevels?.veryHigh;
        if (typeof veryHigh === 'number' && veryHigh >= 0) {
          // Clamp to reasonable range — never below 1k, never above 10M microLamports/CU
          const clamped = Math.max(1_000, Math.min(veryHigh, 10_000_000));
          this.feeCache = { veryHighMicroLamports: clamped, cachedAt: Date.now() };
          this.logger.debug(`Priority fee estimate: ${clamped} µLamports/CU (veryHigh)`);
          return clamped;
        }
      }
    } catch (e: any) {
      this.logger.debug(`Priority fee estimate failed (using fallback): ${e.message}`);
    }

    return FALLBACK_VERY_HIGH_MICRO;
  }

  /**
   * Convert microLamports/CU → lamports for use as Jupiter's maxLamports cap.
   * Hard-capped at MAX_LAMPORTS_HARD_CAP to protect users from extreme fee events.
   */
  computeMaxLamports(microLamportsPerCu: number): number {
    const lamports = Math.ceil((microLamportsPerCu * JUPITER_SWAP_CU_ESTIMATE) / 1_000_000);
    return Math.min(lamports, MAX_LAMPORTS_HARD_CAP);
  }

  /**
   * Synchronous fee accessor for the burst hot path. Returns the cached
   * value if present, the fallback otherwise — never awaits, never fetches.
   * Burst arming pre-warms the cache, so this returns a real estimate.
   * Schedules a background refresh if the cache is stale.
   */
  getPriorityFeeSync(): number {
    if (this.feeCache && Date.now() - this.feeCache.cachedAt < FEE_CACHE_TTL_MS) {
      return this.feeCache.veryHighMicroLamports;
    }
    // Stale or missing — kick off a refresh, return last-known or fallback.
    this.getPriorityFeeEstimate().catch(() => {});
    return this.feeCache?.veryHighMicroLamports ?? FALLBACK_VERY_HIGH_MICRO;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private extractApiKey(url: string): string | null {
    try {
      const u = new URL(url);
      return u.searchParams.get('api-key') ?? u.searchParams.get('apiKey') ?? null;
    } catch {
      return null;
    }
  }

  private deriveStakedUrl(rpcUrl: string, apiKey: string | null): string | null {
    if (!apiKey) return null;
    // Staked endpoint requires Helius paid plan — only enable if HELIUS_STAKED=true
    if (process.env.HELIUS_STAKED !== 'true') return null;
    try {
      const u = new URL(rpcUrl);
      if (!u.hostname.includes('helius')) return null;
      return `https://staked.helius-rpc.com/?api-key=${apiKey}`;
    } catch {
      return null;
    }
  }

  /**
   * Custom fetch wrapper: removes the API key from error messages / logs so it
   * never appears in stack traces or log aggregators.
   */
  private buildFetch(): typeof fetch {
    const apiKey = this.apiKey;
    if (!apiKey) return fetch;
    return (input, init) => {
      return fetch(input, init).catch((err: Error) => {
        if (err.message?.includes(apiKey)) {
          err.message = err.message.replace(apiKey, '[REDACTED]');
        }
        throw err;
      });
    };
  }
}
