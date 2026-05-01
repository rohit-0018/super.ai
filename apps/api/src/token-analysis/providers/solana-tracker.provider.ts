import { Injectable, Logger } from '@nestjs/common';
import { HttpError, http } from '../../common/http';

export interface SolanaTrackerHolders {
  totalHolders?: number;
  top10ConcentrationPct?: number;
  top100ConcentrationPct?: number;
  topHolders: Array<{ address: string; pct: number; amount: number }>;
}

export interface SolanaTrackerRisk {
  rugScore?: number;
  flags: string[];
  mintAuthority: boolean;
  freezeAuthority: boolean;
  lpBurned?: boolean;
}

export interface SolanaTrackerLifecycle {
  launchPlatform: 'pump.fun' | 'pumpswap' | 'raydium' | 'other' | 'unknown';
  stage: 'bonding' | 'graduated' | 'migrated' | 'mature' | 'unknown';
  bondingCurvePct?: number;
  graduatedAt?: string;
  kingOfTheHill: boolean;
}

/**
 * Solana Tracker API — free tier with API key.
 * Endpoint: https://data.solanatracker.io
 * Provides: top-100 holders, risk score, lifecycle (pump.fun graduation).
 *
 * Get key: https://www.solanatracker.io (free registration)
 */
@Injectable()
export class SolanaTrackerProvider {
  private readonly logger = new Logger(SolanaTrackerProvider.name);
  private readonly base = 'https://data.solanatracker.io';
  private readonly apiKey: string | null;

  constructor() {
    this.apiKey = process.env.SOLANA_TRACKER_API_KEY ?? null;
    if (!this.apiKey) {
      this.logger.warn('SOLANA_TRACKER_API_KEY not set — SolanaTracker disabled');
    }
  }

  get isAvailable(): boolean { return !!this.apiKey; }

  async getHolders(mint: string): Promise<SolanaTrackerHolders | null> {
    if (!this.apiKey) return null;
    try {
      const data = await http.get<any>(`${this.base}/holders/${mint}`, {
        headers: { 'x-api-key': this.apiKey },
        timeoutMs: 10_000,
      });
      if (!data) return null;

      const holders: Array<any> = Array.isArray(data.holders) ? data.holders : [];
      const total = typeof data.total === 'number' ? data.total : undefined;

      const top10pct = holders.slice(0, 10).reduce((s, h) => s + (Number(h.percentage) || 0), 0);
      const top100pct = holders.slice(0, 100).reduce((s, h) => s + (Number(h.percentage) || 0), 0);

      return {
        totalHolders: total,
        top10ConcentrationPct: holders.length >= 10 ? Math.min(100, top10pct) : undefined,
        top100ConcentrationPct: holders.length >= 100 ? Math.min(100, top100pct) : undefined,
        topHolders: holders.slice(0, 20).map((h) => ({
          address: h.wallet ?? h.address ?? '',
          pct: Number(h.percentage) || 0,
          amount: Number(h.amount) || 0,
        })),
      };
    } catch (e: any) {
      if (e instanceof HttpError && e.status === 404) return null;
      this.logger.warn(`SolanaTracker holders failed for ${mint}: ${e.message}`);
      return null;
    }
  }

  async getRisk(mint: string): Promise<SolanaTrackerRisk | null> {
    if (!this.apiKey) return null;
    try {
      const data = await http.get<any>(`${this.base}/tokens/${mint}`, {
        headers: { 'x-api-key': this.apiKey },
        timeoutMs: 10_000,
      });
      if (!data?.risk) return null;

      const risk = data.risk;
      const flags: string[] = [];
      if (risk.risks && Array.isArray(risk.risks)) {
        for (const r of risk.risks) {
          if (r.level !== 'low') flags.push(`${r.name}: ${r.description ?? r.level}`);
        }
      }

      return {
        rugScore: typeof risk.score === 'number' ? Math.min(100, risk.score) : undefined,
        flags,
        mintAuthority: !!(risk.rugged || data.token?.mintAuthority),
        freezeAuthority: !!(data.token?.freezeAuthority),
        lpBurned: risk.lpBurned ?? undefined,
      };
    } catch (e: any) {
      if (e instanceof HttpError && e.status === 404) return null;
      this.logger.warn(`SolanaTracker risk failed for ${mint}: ${e.message}`);
      return null;
    }
  }

  async getLifecycle(mint: string): Promise<SolanaTrackerLifecycle | null> {
    if (!this.apiKey) return null;
    try {
      const data = await http.get<any>(`${this.base}/tokens/${mint}`, {
        headers: { 'x-api-key': this.apiKey },
        timeoutMs: 10_000,
      });
      if (!data) return null;

      const pools: any[] = Array.isArray(data.pools) ? data.pools : [];
      const isPumpFun = pools.some((p) => /pump/i.test(p?.market ?? ''));
      const isPumpSwap = pools.some((p) => /pumpswap/i.test(p?.market ?? ''));
      const isRaydium = pools.some((p) => /raydium/i.test(p?.market ?? ''));

      let launchPlatform: SolanaTrackerLifecycle['launchPlatform'] = 'unknown';
      if (isPumpSwap) launchPlatform = 'pumpswap';
      else if (isPumpFun) launchPlatform = 'pump.fun';
      else if (isRaydium) launchPlatform = 'raydium';
      else if (pools.length > 0) launchPlatform = 'other';

      // Bonding curve progress from pump.fun pool data
      const pumpPool = pools.find((p) => /pump/i.test(p?.market ?? ''));
      const bondingCurvePct = pumpPool?.bondingCurveProgress != null
        ? Number(pumpPool.bondingCurveProgress)
        : undefined;

      let stage: SolanaTrackerLifecycle['stage'] = 'unknown';
      if (isPumpSwap || isPumpFun) {
        if (bondingCurvePct != null && bondingCurvePct < 100) stage = 'bonding';
        else stage = 'graduated';
      } else if (isRaydium || pools.length > 0) {
        stage = 'mature';
      }

      return {
        launchPlatform,
        stage,
        bondingCurvePct,
        graduatedAt: undefined, // not available from this endpoint
        kingOfTheHill: pumpPool?.isKingOfTheHill ?? false,
      };
    } catch (e: any) {
      if (e instanceof HttpError && e.status === 404) return null;
      this.logger.warn(`SolanaTracker lifecycle failed for ${mint}: ${e.message}`);
      return null;
    }
  }
}
