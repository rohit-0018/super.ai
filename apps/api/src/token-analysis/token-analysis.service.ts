import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { GoPlusProvider } from '../token-intel/providers/goplus.provider';
import { RugCheckProvider } from '../token-intel/providers/rugcheck.provider';
import { DexScreenerProvider } from './providers/dexscreener.provider';
import { GeckoTerminalProvider } from './providers/geckoterminal.provider';
import { runPlaybooks } from './playbooks';
import type {
  Chain,
  ProviderStatus,
  SafetySignals,
  TokenAnalysisReport,
  TokenMeta,
} from './token-analysis.types';

/** DexScreener chainId → GoPlus chain id. */
const GOPLUS_CHAIN_BY_DEX: Record<string, string> = {
  ethereum: '1',
  bsc: '56',
  polygon: '137',
  arbitrum: '42161',
  optimism: '10',
  base: '8453',
  avalanche: '43114',
};

@Injectable()
export class TokenAnalysisService {
  private readonly logger = new Logger(TokenAnalysisService.name);
  private readonly cacheTtlMs = 60_000;
  private cache = new Map<string, { report: TokenAnalysisReport; ts: number }>();

  constructor(
    private dexscreener: DexScreenerProvider,
    private gecko: GeckoTerminalProvider,
    private goplus: GoPlusProvider,
    private rugcheck: RugCheckProvider,
  ) {}

  async analyze(chain: Chain, rawAddress: string): Promise<TokenAnalysisReport> {
    const address = (rawAddress ?? '').trim();
    if (!address) throw new BadRequestException('address is required');
    if (chain === 'EVM' && !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      throw new BadRequestException('Invalid EVM address');
    }
    if (chain === 'SOLANA' && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
      throw new BadRequestException('Invalid Solana address');
    }

    const cacheKey = `${chain}:${address.toLowerCase()}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.cacheTtlMs) return cached.report;

    const providers: ProviderStatus[] = [];

    // 1) DexScreener — market data + chainId hint
    let dexMeta: TokenMeta | null = null;
    try {
      dexMeta = await this.dexscreener.getToken(chain, address);
      providers.push({
        name: 'DexScreener',
        status: dexMeta ? 'hit' : 'miss',
        note: dexMeta ? `${dexMeta.chainId} · ${dexMeta.dex}` : 'No indexed pair found',
      });
    } catch (e: any) {
      this.logger.warn(`DexScreener error: ${e?.message}`);
      providers.push({ name: 'DexScreener', status: 'error', note: e?.message ?? 'fetch failed' });
    }

    // 2) GeckoTerminal — fills gaps (holder count, market cap, FDV, additional priceChange)
    let geckoMeta: any = null;
    try {
      geckoMeta = await this.gecko.getToken(chain, address, dexMeta?.chainId);
      providers.push({
        name: 'GeckoTerminal',
        status: geckoMeta ? 'hit' : 'miss',
        note: geckoMeta ? 'supplemented' : 'token not indexed',
      });
    } catch (e: any) {
      this.logger.warn(`GeckoTerminal error: ${e?.message}`);
      providers.push({ name: 'GeckoTerminal', status: 'error', note: e?.message ?? 'fetch failed' });
    }

    // 3) Safety provider — chain-aware
    const { signals: safety, providerEntries } = await this.fetchSafety(chain, address, dexMeta);
    providers.push(...providerEntries);

    if (!dexMeta && providers.every((p) => p.status !== 'hit')) {
      throw new BadRequestException({
        error: 'no_data',
        message:
          'No provider returned data for this token. Double-check the address and chain. ' +
          '(Brand-new or unlisted tokens may not be indexed yet.)',
        providers,
      });
    }

    // Merge: prefer DexScreener for trade-pair fields (volume per pair, txns, dex, age),
    // fill nulls from GeckoTerminal (mcap, FDV, holders, price changes when missing).
    const merged: TokenMeta = dexMeta ?? { chain, address, priceChange: {} };
    if (geckoMeta) {
      merged.symbol        = merged.symbol        ?? geckoMeta.symbol;
      merged.name          = merged.name          ?? geckoMeta.name;
      merged.priceUsd      = merged.priceUsd      ?? geckoMeta.priceUsd;
      merged.marketCapUsd  = merged.marketCapUsd  ?? geckoMeta.marketCapUsd;
      merged.fdvUsd        = merged.fdvUsd        ?? geckoMeta.fdvUsd;
      merged.volume24hUsd  = merged.volume24hUsd  ?? geckoMeta.volume24hUsd;
      merged.priceChange   = {
        ...(geckoMeta.priceChange ?? {}),
        ...merged.priceChange, // DexScreener wins where present
      };
      // GeckoTerminal holder count populates safety if RugCheck/GoPlus missed it
      if (safety.holdersCount == null && geckoMeta.holdersCount != null) {
        safety.holdersCount = geckoMeta.holdersCount;
      }
    }
    const meta: TokenMeta = merged;

    // Playbook builder applies its own per-playbook evidence threshold and
    // returns score=null + verdict=insufficient_data when not enough signals fired.
    const playbooks = runPlaybooks(meta, safety);

    const report: TokenAnalysisReport = {
      meta,
      safety,
      playbooks,
      generatedAt: new Date().toISOString(),
      cacheTtlSec: this.cacheTtlMs / 1000,
      providers,
      dataSources: providers.filter((p) => p.status === 'hit').map((p) => p.name),
      disclaimer:
        'qwai analysis is informational only, not financial advice. Trade at your own risk. ' +
        'Free-tier data: Nansen / Arkham smart-money labels not wired; some signals are heuristic approximations.',
    };

    this.cache.set(cacheKey, { report, ts: Date.now() });
    return report;
  }

  private async fetchSafety(
    chain: Chain,
    address: string,
    dexMeta: TokenMeta | null,
  ): Promise<{ signals: SafetySignals; providerEntries: ProviderStatus[] }> {
    const flags: string[] = [];
    const providerEntries: ProviderStatus[] = [];
    const out: SafetySignals = { flags };

    if (chain === 'EVM') {
      // Route GoPlus to the chain DexScreener detected; default Ethereum.
      const gpChainId = (dexMeta?.chainId && GOPLUS_CHAIN_BY_DEX[dexMeta.chainId]) || '1';
      const chainName = dexMeta?.chainId || 'ethereum';
      try {
        const gp = await this.goplus.tokenSecurity(gpChainId, address);
        if (gp) {
          providerEntries.push({ name: `GoPlus (${chainName})`, status: 'hit' });
          out.honeypot = gp.is_honeypot === '1' ? 'yes' : gp.is_honeypot === '0' ? 'no' : 'unknown';
          out.buyTax = toBps(gp.buy_tax);
          out.sellTax = toBps(gp.sell_tax);
          out.transferTax = toBps(gp.transfer_tax);
          out.holdersCount = numOrU(gp.holder_count);
          out.topHoldersPct = computeTopHoldersPct(gp);
          out.lpLocked = gp.lp_holders ? lpLockedFromHolders(gp.lp_holders) : 'unknown';
          if (gp.is_honeypot === '1') flags.push('Honeypot flagged by GoPlus');
          if (gp.hidden_owner === '1') flags.push('Hidden owner');
          if (gp.can_take_back_ownership === '1') flags.push('Ownership can be reclaimed by deployer');
          if (gp.is_proxy === '1') flags.push('Upgradable proxy contract');
          if (gp.external_call === '1') flags.push('External call in transfer — non-standard');
          out.rugScore = heuristicRugScoreEvm(gp);
        } else {
          providerEntries.push({
            name: `GoPlus (${chainName})`,
            status: 'miss',
            note: 'Token not indexed on this chain',
          });
        }
      } catch (e: any) {
        this.logger.warn(`GoPlus failed: ${e?.message}`);
        providerEntries.push({ name: `GoPlus (${chainName})`, status: 'error', note: e?.message });
      }
    }

    if (chain === 'SOLANA') {
      try {
        const rc: any = await this.rugcheck.tokenReport(address);
        if (rc) {
          providerEntries.push({ name: 'RugCheck', status: 'hit' });
          out.rugScore = numOrU(rc.score);
          out.holdersCount = numOrU(rc.totalHolders);
          const risks: any[] = Array.isArray(rc.risks) ? rc.risks : [];
          out.mintAuthority = risks.some((r: any) => /mint authority/i.test(r?.name ?? ''));
          out.freezeAuthority = risks.some((r: any) => /freeze authority/i.test(r?.name ?? ''));
          for (const r of risks) {
            if (r?.name && r?.level && r.level !== 'info') {
              flags.push(`${r.name}: ${r.description ?? r.level}`);
            }
          }
          if (Array.isArray(rc.topHolders) && rc.topHolders.length) {
            const top10 = rc.topHolders.slice(0, 10)
              .reduce((s: number, h: any) => s + (Number(h.pct) || 0), 0);
            if (Number.isFinite(top10)) out.topHoldersPct = top10;
          }
          if (rc.markets && Array.isArray(rc.markets)) {
            const locked = rc.markets.some((m: any) => m?.lpLocked === true || m?.lpLockedPct === 100);
            out.lpLocked = locked ? 'yes' : 'no';
          }
        } else {
          providerEntries.push({ name: 'RugCheck', status: 'miss', note: 'No report for this mint' });
        }
      } catch (e: any) {
        this.logger.warn(`RugCheck failed: ${e?.message}`);
        providerEntries.push({ name: 'RugCheck', status: 'error', note: e?.message });
      }
    }

    return { signals: out, providerEntries };
  }
}

function numOrU(v: any): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function toBps(v: any): number | undefined {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.round(n * 10000);
}
function computeTopHoldersPct(gp: any): number | undefined {
  if (!Array.isArray(gp?.holders)) return undefined;
  const top = gp.holders.slice(0, 10);
  const sum = top.reduce((s: number, h: any) => s + (Number(h?.percent) || 0), 0);
  return Number.isFinite(sum) ? Math.min(100, sum * 100) : undefined;
}
function lpLockedFromHolders(holders: any[]): 'yes' | 'no' | 'unknown' {
  if (!Array.isArray(holders)) return 'unknown';
  const anyLocked = holders.some((h) => h?.is_locked === '1' || h?.is_locked === 1);
  return anyLocked ? 'yes' : 'no';
}
function heuristicRugScoreEvm(gp: any): number {
  let s = 0;
  if (gp.is_honeypot === '1') s += 60;
  if (gp.hidden_owner === '1') s += 12;
  if (gp.can_take_back_ownership === '1') s += 10;
  if (gp.is_proxy === '1') s += 6;
  if (Number(gp.buy_tax) >= 0.1) s += 8;
  if (Number(gp.sell_tax) >= 0.1) s += 10;
  if (gp.owner_change_balance === '1') s += 8;
  return Math.min(100, s);
}
