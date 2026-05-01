import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GoPlusProvider } from '../token-intel/providers/goplus.provider';
import { RugCheckProvider } from '../token-intel/providers/rugcheck.provider';
import { DexScreenerProvider } from './providers/dexscreener.provider';
import { GeckoTerminalProvider } from './providers/geckoterminal.provider';
import { HeliusHoldersProvider } from './providers/helius-holders.provider';
import { SocialProvider } from './providers/social.provider';
import { SmartMoneyProvider } from './providers/smart-money.provider';
import { AiReasoner } from './ai-reasoner';
import { detectChain } from './chain-detector';
import { checkKill } from './kill-switch';
import { runPlaybooks } from './playbooks';
import type {
  Chain,
  HolderMetrics,
  KillResult,
  ProviderStatus,
  SafetySignals,
  SmartMoneyResult,
  SocialData,
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
  // Both TTLs configurable via env — default 60s in-memory, 120s DB.
  // Set INTEL_CACHE_TTL_SEC=30 for more aggressive freshness.
  private readonly cacheTtlMs = parseInt(process.env.INTEL_CACHE_TTL_SEC ?? '60') * 1_000;
  private readonly dbCacheTtlMs = parseInt(process.env.INTEL_DB_CACHE_TTL_SEC ?? '120') * 1_000;
  // True if any LLM is configured — used to decide whether to skip cache with no AI reasoning.
  private readonly aiEnabled = !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);
  private cache = new Map<string, { report: TokenAnalysisReport; ts: number }>();

  constructor(
    private prisma: PrismaService,
    private dexscreener: DexScreenerProvider,
    private gecko: GeckoTerminalProvider,
    private goplus: GoPlusProvider,
    private rugcheck: RugCheckProvider,
    private heliusHolders: HeliusHoldersProvider,
    private social: SocialProvider,
    private smartMoney: SmartMoneyProvider,
    private aiReasoner: AiReasoner,
  ) {}

  /**
   * Fast analysis: DexScreener + safety + kill + playbooks only.
   * No Helius, Social, Smart Money, or Claude. Target <2s.
   */
  async analyzeShort(rawAddress: string): Promise<TokenAnalysisReport> {
    const address = (rawAddress ?? '').trim();
    const chain = detectChain(address);
    if (!chain) {
      throw new BadRequestException(
        'Could not detect chain from address format. ' +
        'Solana addresses are base58 (32-44 chars). EVM addresses start with 0x and are 42 chars.',
      );
    }

    const normalizedAddress = chain === 'EVM' ? address.toLowerCase() : address;
    const cacheKey = `short:${chain}:${normalizedAddress}`;

    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.cacheTtlMs) return cached.report;

    const providers: ProviderStatus[] = [];

    let dexMeta: TokenMeta | null = null;
    try {
      dexMeta = await this.dexscreener.getToken(chain, address);
      providers.push({
        name: 'DexScreener',
        status: dexMeta ? 'hit' : 'miss',
        note: dexMeta ? `${dexMeta.chainId} · ${dexMeta.dex}` : 'No indexed pair found',
      });
    } catch (e: any) {
      providers.push({ name: 'DexScreener', status: 'error', note: e?.message ?? 'fetch failed' });
    }

    let geckoMeta: any = null;
    try {
      geckoMeta = await this.gecko.getToken(chain, address, dexMeta?.chainId);
      providers.push({ name: 'GeckoTerminal', status: geckoMeta ? 'hit' : 'miss' });
    } catch (e: any) {
      providers.push({ name: 'GeckoTerminal', status: 'error', note: e?.message ?? 'fetch failed' });
    }

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

    const merged: TokenMeta = dexMeta ?? { chain, address, priceChange: {} };
    if (geckoMeta) {
      merged.symbol       = merged.symbol       ?? geckoMeta.symbol;
      merged.name         = merged.name         ?? geckoMeta.name;
      merged.priceUsd     = merged.priceUsd     ?? geckoMeta.priceUsd;
      merged.marketCapUsd = merged.marketCapUsd ?? geckoMeta.marketCapUsd;
      merged.fdvUsd       = merged.fdvUsd       ?? geckoMeta.fdvUsd;
      merged.volume24hUsd = merged.volume24hUsd ?? geckoMeta.volume24hUsd;
      merged.priceChange  = { ...(geckoMeta.priceChange ?? {}), ...merged.priceChange };
      if (safety.holdersCount == null && geckoMeta.holdersCount != null) {
        safety.holdersCount = geckoMeta.holdersCount;
      }
    }

    const kill = checkKill(safety, merged);
    const playbooks = runPlaybooks(merged, safety);
    const report = this.buildReport(merged, safety, playbooks, providers, kill);

    this.cache.set(cacheKey, { report, ts: Date.now() });
    return report;
  }

  /**
   * Auto-detect chain from address format, then analyze.
   * force=true bypasses all caches (in-memory + DB) and re-runs the full pipeline.
   */
  async analyzeAddress(rawAddress: string, force = false): Promise<TokenAnalysisReport> {
    const address = (rawAddress ?? '').trim();
    const chain = detectChain(address);
    if (!chain) {
      throw new BadRequestException(
        'Could not detect chain from address format. ' +
        'Solana addresses are base58 (32-44 chars). EVM addresses start with 0x and are 42 chars.',
      );
    }
    return this.analyze(chain, address, force);
  }

  async analyze(chain: Chain, rawAddress: string, force = false): Promise<TokenAnalysisReport> {
    const address = (rawAddress ?? '').trim();
    if (!address) throw new BadRequestException('address is required');
    if (chain === 'EVM' && !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      throw new BadRequestException('Invalid EVM address');
    }
    if (chain === 'SOLANA' && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
      throw new BadRequestException('Invalid Solana address');
    }

    // EVM addresses are case-insensitive (normalize for dedup).
    // Solana addresses are base58 and case-sensitive — never lowercase them.
    const normalizedAddress = chain === 'EVM' ? address.toLowerCase() : address;
    const cacheKey = `${chain}:${normalizedAddress}`;

    // ── In-memory cache ───────────────────────────────────────────────────────
    // Skip cache if force=true, OR if Claude is configured but cached result has no AI reasoning
    // (prevents serving stale no-AI results from a previous run where Claude failed/wasn't set).
    if (!force) {
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() - cached.ts < this.cacheTtlMs) {
        const aiOk = !!cached.report.aiReasoning || !this.aiEnabled;
        if (aiOk) return cached.report;
      }

      // ── DB cache ────────────────────────────────────────────────────────────
      const dbCached = await this.loadFromDb(chain, normalizedAddress);
      if (dbCached) {
        const aiOk = !!dbCached.aiReasoning || !this.aiEnabled;
        if (aiOk) {
          this.cache.set(cacheKey, { report: dbCached, ts: Date.now() });
          return dbCached;
        }
        // Cached result has no AI reasoning but Claude is now configured — fall through to re-run.
        this.logger.log(`Cache miss (no aiReasoning, Claude enabled) for ${normalizedAddress} — re-running`);
      }
    }

    const providers: ProviderStatus[] = [];

    // ── 1. Market data ────────────────────────────────────────────────────────
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

    // ── 2. Safety (needs dexMeta.chainId for GoPlus chain routing) ────────────
    let rawRugcheckRisks: any[] | undefined;
    const { signals: safety, providerEntries, rugcheckRisks } = await this.fetchSafety(
      chain, address, dexMeta,
    );
    rawRugcheckRisks = rugcheckRisks;
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

    // ── 3. Merge meta ────────────────────────────────────────────────────────
    const merged: TokenMeta = dexMeta ?? { chain, address, priceChange: {} };
    if (geckoMeta) {
      merged.symbol        = merged.symbol        ?? geckoMeta.symbol;
      merged.name          = merged.name          ?? geckoMeta.name;
      merged.priceUsd      = merged.priceUsd      ?? geckoMeta.priceUsd;
      merged.marketCapUsd  = merged.marketCapUsd  ?? geckoMeta.marketCapUsd;
      merged.fdvUsd        = merged.fdvUsd        ?? geckoMeta.fdvUsd;
      merged.volume24hUsd  = merged.volume24hUsd  ?? geckoMeta.volume24hUsd;
      merged.priceChange   = { ...(geckoMeta.priceChange ?? {}), ...merged.priceChange };
      if (safety.holdersCount == null && geckoMeta.holdersCount != null) {
        safety.holdersCount = geckoMeta.holdersCount;
      }
    }
    const meta: TokenMeta = merged;

    // ── 4. Kill switch ────────────────────────────────────────────────────────
    const kill: KillResult = checkKill(safety, meta);
    if (kill.triggered) {
      const report = this.buildReport(meta, safety, runPlaybooks(meta, safety), providers, kill);
      this.cache.set(cacheKey, { report, ts: Date.now() });
      await this.persistToDb(chain, normalizedAddress, report);
      return report;
    }

    // ── 5. Intelligence layer — all in parallel ───────────────────────────────
    const [holdersResult, socialResult, smartMoneyResult] = await Promise.allSettled([
      chain === 'SOLANA'
        ? this.heliusHolders.getHolderMetrics(address, rawRugcheckRisks)
        : Promise.resolve(null),
      this.social.getData(meta),
      this.smartMoney.check(address, chain),
    ]);

    const holderMetrics: HolderMetrics | undefined =
      holdersResult.status === 'fulfilled' ? (holdersResult.value ?? undefined) : undefined;
    const socialData: SocialData | undefined =
      socialResult.status === 'fulfilled' ? socialResult.value : undefined;
    const smartMoneyData: SmartMoneyResult | undefined =
      smartMoneyResult.status === 'fulfilled' ? smartMoneyResult.value : undefined;

    if (holderMetrics) {
      providers.push({ name: 'Helius (holders)', status: 'hit' });
      if (holderMetrics.top10ConcentrationPct != null) {
        safety.topHoldersPct = holderMetrics.top10ConcentrationPct;
      }
      // Backfill totalHolders from RugCheck if Helius didn't provide it
      if (holderMetrics.totalHolders == null && safety.holdersCount != null) {
        holderMetrics.totalHolders = safety.holdersCount;
      }
    }
    if (socialData) providers.push({ name: 'Social', status: 'hit' });
    if (smartMoneyData?.holdersFound) providers.push({ name: 'Smart Money', status: 'hit' });

    // ── 6. Claude AI reasoning ────────────────────────────────────────────────
    const playbooks = runPlaybooks(meta, safety);
    const aiReasoning = await this.aiReasoner.analyze(
      meta, safety, holderMetrics, socialData, smartMoneyData,
    ) ?? undefined;

    if (aiReasoning) providers.push({ name: 'AI Reasoner (Claude)', status: 'hit' });

    const report = this.buildReport(
      meta, safety, playbooks, providers, kill,
      holderMetrics, socialData, smartMoneyData, aiReasoning,
    );
    this.cache.set(cacheKey, { report, ts: Date.now() });
    await this.persistToDb(chain, normalizedAddress, report);
    return report;
  }

  /** Invalidate cache for a specific token (e.g., after re-analysis requested). */
  invalidateCache(chain: Chain, address: string) {
    const normalized = chain === 'EVM' ? address.toLowerCase() : address;
    this.cache.delete(`${chain}:${normalized}`);
  }

  // address param is already chain-normalized by callers (EVM lowercased, Solana as-is).
  private async loadFromDb(chain: Chain, address: string): Promise<TokenAnalysisReport | null> {
    try {
      const record = await this.prisma.tokenIntel.findFirst({
        where: {
          chain: chain as any,
          address,
          aiAnalyzedAt: { gte: new Date(Date.now() - this.dbCacheTtlMs) },
        },
        orderBy: { aiAnalyzedAt: 'desc' },
      });
      if (!record?.fullReport) return null;
      return record.fullReport as unknown as TokenAnalysisReport;
    } catch (e: any) {
      this.logger.warn(`DB cache read failed: ${e?.message}`);
      return null;
    }
  }

  private async persistToDb(chain: Chain, address: string, report: TokenAnalysisReport): Promise<void> {
    try {
      const ai = report.aiReasoning;
      const toJson = (v: unknown): any => (v != null ? v : undefined);

      const payload = {
        symbol: report.meta.symbol,
        name: report.meta.name,
        aiScore: ai?.score ?? undefined,
        aiVerdict: ai?.verdict ?? undefined,
        aiSummary: ai?.summary ?? undefined,
        aiReasoning: toJson(ai),
        killTriggered: report.kill?.triggered ?? false,
        killReason: report.kill?.reason ?? undefined,
        holderMetrics: toJson(report.holderMetrics),
        socialData: toJson(report.socialData),
        smartMoneyData: toJson(report.smartMoney),
        fullReport: toJson(report),
        aiAnalyzedAt: new Date(),
      };

      await this.prisma.tokenIntel.upsert({
        where: { chain_address: { chain: chain as any, address } },
        create: { chain: chain as any, address, ...payload },
        update: payload,
      });
    } catch (e: any) {
      this.logger.warn(`DB persist failed: ${e?.message}`);
    }
  }

  private buildReport(
    meta: TokenMeta,
    safety: SafetySignals,
    playbooks: ReturnType<typeof runPlaybooks>,
    providers: ProviderStatus[],
    kill: KillResult,
    holderMetrics?: HolderMetrics,
    socialData?: SocialData,
    smartMoney?: SmartMoneyResult,
    aiReasoning?: TokenAnalysisReport['aiReasoning'],
  ): TokenAnalysisReport {
    return {
      meta,
      safety,
      playbooks,
      generatedAt: new Date().toISOString(),
      cacheTtlSec: this.cacheTtlMs / 1000,
      providers,
      dataSources: providers.filter((p) => p.status === 'hit').map((p) => p.name),
      disclaimer:
        'qwai analysis is informational only, not financial advice. Trade at your own risk. ' +
        'Free-tier data: Nansen / Arkham smart-money labels not wired; some signals are heuristic.',
      kill:          kill.triggered ? kill : undefined,
      holderMetrics,
      socialData,
      smartMoney,
      aiReasoning,
    };
  }

  private async fetchSafety(
    chain: Chain,
    address: string,
    dexMeta: TokenMeta | null,
  ): Promise<{ signals: SafetySignals; providerEntries: ProviderStatus[]; rugcheckRisks?: any[] }> {
    const flags: string[] = [];
    const providerEntries: ProviderStatus[] = [];
    const out: SafetySignals = { flags };
    let rugcheckRisks: any[] | undefined;

    if (chain === 'EVM') {
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
          // RugCheck score is 0-1000; normalize to 0-100 to match EVM heuristic scale.
          const rawScore = numOrU(rc.score);
          out.rugScore = rawScore != null ? Math.min(100, Math.round(rawScore / 10)) : undefined;
          out.holdersCount = numOrU(rc.totalHolders);
          const risks: any[] = Array.isArray(rc.risks) ? rc.risks : [];
          rugcheckRisks = risks;
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

    return { signals: out, providerEntries, rugcheckRisks };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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
