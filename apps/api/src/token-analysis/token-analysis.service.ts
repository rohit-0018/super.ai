import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderPoolService } from '../provider-pool/provider-pool.service';
import { GoPlusProvider } from '../token-intel/providers/goplus.provider';
import { RugCheckProvider } from '../token-intel/providers/rugcheck.provider';
import { DexScreenerProvider } from './providers/dexscreener.provider';
import { GeckoTerminalProvider } from './providers/geckoterminal.provider';
import { HeliusHoldersProvider } from './providers/helius-holders.provider';
import { SocialProvider } from './providers/social.provider';
import { SmartMoneyProvider } from './providers/smart-money.provider';
import { JupiterProvider } from './providers/jupiter.provider';
import { SolanaTrackerProvider } from './providers/solana-tracker.provider';
import { MoralisProvider } from './providers/moralis.provider';
import { BundleCheckerProvider } from './providers/bundle-checker.provider';
import { BirdeyeProvider } from './providers/birdeye.provider';
import { DeFiLlamaProvider } from './providers/defillama.provider';
import { EtherscanProvider } from './providers/etherscan.provider';
import { BitqueryProvider } from './providers/bitquery.provider';
import { GmgnProvider } from './providers/gmgn.provider';
import { ArkhamProvider } from './providers/arkham.provider';
import { WaybackProvider } from './providers/wayback.provider';
import { AiReasoner } from './ai-reasoner';
import { ComparableTokensService } from './comparable-tokens.service';
import { getProfile } from './profile.config';
import { buildTradingStrategy } from './trading-strategy.engine';
import { detectChain } from './chain-detector';
import { checkKill } from './kill-switch';
import { runPlaybooks } from './playbooks';
import type {
  BundleInfo,
  Chain,
  ChainContext,
  ComparableToken,
  HolderMetrics,
  KillResult,
  LifecycleInfo,
  PriceImpact,
  ProviderStatus,
  ReportDepth,
  SafetySignals,
  SmartMoneyResult,
  SmartMoneySignal,
  SocialData,
  TokenAnalysisReport,
  TokenMeta,
  TradingProfile,
} from './token-analysis.types';

const GOPLUS_CHAIN_BY_DEX: Record<string, string> = {
  ethereum: '1', bsc: '56', polygon: '137', arbitrum: '42161',
  optimism: '10', base: '8453', avalanche: '43114',
};

@Injectable()
export class TokenAnalysisService {
  private readonly logger = new Logger(TokenAnalysisService.name);
  private readonly cacheTtlMs = parseInt(process.env.INTEL_CACHE_TTL_SEC ?? '60') * 1_000;
  private readonly dbCacheTtlMs = parseInt(process.env.INTEL_DB_CACHE_TTL_SEC ?? '720') * 1_000;
  private readonly aiEnabled = !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);
  private cache = new Map<string, { report: TokenAnalysisReport; ts: number }>();

  constructor(
    private prisma: PrismaService,
    private pool: ProviderPoolService,
    private dexscreener: DexScreenerProvider,
    private gecko: GeckoTerminalProvider,
    private goplus: GoPlusProvider,
    private rugcheck: RugCheckProvider,
    private heliusHolders: HeliusHoldersProvider,
    private social: SocialProvider,
    private smartMoney: SmartMoneyProvider,
    private jupiter: JupiterProvider,
    private solanaTracker: SolanaTrackerProvider,
    private moralis: MoralisProvider,
    private bundleChecker: BundleCheckerProvider,
    private birdeye: BirdeyeProvider,
    private defillama: DeFiLlamaProvider,
    private etherscan: EtherscanProvider,
    private bitquery: BitqueryProvider,
    private gmgn: GmgnProvider,
    private arkham: ArkhamProvider,
    private wayback: WaybackProvider,
    private aiReasoner: AiReasoner,
    private comparableTokens: ComparableTokensService,
  ) {}

  async analyzeShort(rawAddress: string): Promise<TokenAnalysisReport> {
    const address = (rawAddress ?? '').trim();
    const chain = detectChain(address);
    if (!chain) throw new BadRequestException('Could not detect chain from address format.');

    const normalizedAddress = chain === 'EVM' ? address.toLowerCase() : address;
    const cacheKey = `short:${chain}:${normalizedAddress}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.cacheTtlMs) return cached.report;

    const providers: ProviderStatus[] = [];
    const [dexMeta, geckoMeta] = await this.fetchMarketData(chain, address, providers);
    const { signals: safety, providerEntries } = await this.fetchSafety(chain, address, dexMeta);
    providers.push(...providerEntries);

    if (!dexMeta && providers.every((p) => p.status !== 'hit')) {
      throw new BadRequestException({ error: 'no_data', message: 'No provider returned data for this token.', providers });
    }

    const merged = this.mergeTokenMeta(dexMeta, geckoMeta, safety);
    const kill = checkKill(safety, merged);
    const playbooks = runPlaybooks(merged, safety);
    const report = this.buildReport(merged, safety, playbooks, providers, kill);
    this.cache.set(cacheKey, { report, ts: Date.now() });
    return report;
  }

  async analyzeAddress(rawAddress: string, force = false): Promise<TokenAnalysisReport> {
    const address = (rawAddress ?? '').trim();
    const chain = detectChain(address);
    if (!chain) throw new BadRequestException('Could not detect chain from address format.');
    return this.analyze(chain, address, force);
  }

  async analyzeWithProfile(
    rawAddress: string,
    profile: TradingProfile,
    depth: ReportDepth,
    force: boolean,
    portfolioUsd: number | null,
  ): Promise<TokenAnalysisReport> {
    const address = (rawAddress ?? '').trim();
    const chain = detectChain(address);
    if (!chain) throw new BadRequestException('Could not detect chain from address format.');

    const profileDef = getProfile(profile);

    // Get base report (reuses data pipeline cache — market, safety, holders, social, smartMoney)
    const base = await this.analyze(chain, address, force);

    // Re-run AI with profile-specific persona (per-profile cache in AiReasoner)
    let aiReasoning = base.aiReasoning;
    if (this.aiEnabled) {
      const profileAi = await this.aiReasoner.analyze(
        base.meta, base.safety,
        base.holderMetrics, base.socialData, base.smartMoney,
        profileDef.aiPersona, profile,
      );
      if (profileAi) {
        aiReasoning = profileAi;
        (base.providers as any).push({ name: `AI Reasoner (${profileDef.label})`, status: 'hit' });
      }
    }

    // Build profile-aware trading strategy
    const tradingStrategy = buildTradingStrategy(
      base.meta, base.safety, base.holderMetrics, base.smartMoney,
      profileDef, portfolioUsd,
    );

    // Comparable tokens for dossier depth
    let comparableTokens: ComparableToken[] | undefined;
    if (depth === 'dossier') {
      comparableTokens = await this.comparableTokens.findComparables(
        chain, address, base.meta.marketCapUsd ?? null, base.meta.pairAgeHours ?? null,
      );
    }

    return {
      ...base,
      aiReasoning,
      profile,
      depth,
      tradingStrategy,
      ...(comparableTokens?.length ? { comparableTokens } : {}),
    };
  }

  async analyze(chain: Chain, rawAddress: string, force = false): Promise<TokenAnalysisReport> {
    const address = (rawAddress ?? '').trim();
    if (!address) throw new BadRequestException('address is required');
    if (chain === 'EVM' && !/^0x[a-fA-F0-9]{40}$/.test(address)) throw new BadRequestException('Invalid EVM address');
    if (chain === 'SOLANA' && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) throw new BadRequestException('Invalid Solana address');

    const normalizedAddress = chain === 'EVM' ? address.toLowerCase() : address;
    const cacheKey = `${chain}:${normalizedAddress}`;

    if (!force) {
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() - cached.ts < this.cacheTtlMs) {
        if (cached.report.aiReasoning || !this.aiEnabled) return cached.report;
      }
      const dbCached = await this.loadFromDb(chain, normalizedAddress);
      if (dbCached) {
        if (dbCached.aiReasoning || !this.aiEnabled) {
          this.cache.set(cacheKey, { report: dbCached, ts: Date.now() });
          return dbCached;
        }
      }
    }

    const providers: ProviderStatus[] = [];

    // ── Layer 1: Market data ──────────────────────────────────────────────
    const [dexMeta, geckoMeta] = await this.fetchMarketData(chain, address, providers);

    // ── Layer 2: Safety ───────────────────────────────────────────────────
    let rawRugcheckRisks: any[] | undefined;
    const { signals: safety, providerEntries, rugcheckRisks } = await this.fetchSafety(chain, address, dexMeta);
    rawRugcheckRisks = rugcheckRisks;
    providers.push(...providerEntries);

    if (!dexMeta && providers.every((p) => p.status !== 'hit')) {
      throw new BadRequestException({ error: 'no_data', message: 'No provider returned data.', providers });
    }

    const meta: TokenMeta = this.mergeTokenMeta(dexMeta, geckoMeta, safety);

    // ── Kill switch ───────────────────────────────────────────────────────
    const kill: KillResult = checkKill(safety, meta);
    if (kill.triggered) {
      const report = this.buildReport(meta, safety, runPlaybooks(meta, safety), providers, kill);
      this.cache.set(cacheKey, { report, ts: Date.now() });
      await this.persistToDb(chain, normalizedAddress, report);
      return report;
    }

    // ── Layer 3: Intelligence — all groups in parallel ────────────────────
    const [
      holderMetrics,
      socialData,
      smartMoneyData,
    ] = await Promise.all([
      this.fetchHolderIntelligence(chain, address, meta, rawRugcheckRisks, providers),
      this.fetchSocialIntelligence(meta, providers),
      this.fetchSmartMoney(address, chain, providers),
    ]);

    // Backfill safety.topHoldersPct from holder metrics if richer
    if (holderMetrics?.top10ConcentrationPct != null) {
      safety.topHoldersPct = holderMetrics.top10ConcentrationPct;
    }
    if (holderMetrics?.totalHolders == null && safety.holdersCount != null) {
      (holderMetrics as any).totalHolders = safety.holdersCount;
    }

    // ── Layer 4: AI reasoning ─────────────────────────────────────────────
    const playbooks = runPlaybooks(meta, safety);
    const aiReasoning = await this.aiReasoner.analyze(meta, safety, holderMetrics, socialData, smartMoneyData) ?? undefined;
    if (aiReasoning) providers.push({ name: 'AI Reasoner (Claude)', status: 'hit' });

    const report = this.buildReport(meta, safety, playbooks, providers, kill, holderMetrics, socialData, smartMoneyData, aiReasoning);
    this.cache.set(cacheKey, { report, ts: Date.now() });
    await this.persistToDb(chain, normalizedAddress, report);
    return report;
  }

  invalidateCache(chain: Chain, address: string) {
    const normalized = chain === 'EVM' ? address.toLowerCase() : address;
    this.cache.delete(`${chain}:${normalized}`);
  }

  // ── Market data layer ──────────────────────────────────────────────────────

  private async fetchMarketData(
    chain: Chain,
    address: string,
    providers: ProviderStatus[],
  ): Promise<[TokenMeta | null, any]> {
    // Primary: DexScreener
    let dexMeta: TokenMeta | null = null;
    try {
      dexMeta = await this.dexscreener.getToken(chain, address);
      providers.push({ name: 'DexScreener', status: dexMeta ? 'hit' : 'miss', note: dexMeta ? `${dexMeta.chainId} · ${dexMeta.dex}` : undefined });
    } catch {
      providers.push({ name: 'DexScreener', status: 'error' });
    }

    // Supplemental: GeckoTerminal (any type — merges only select fields)
    let geckoMeta: any = null;
    try {
      geckoMeta = await this.gecko.getToken(chain, address, dexMeta?.chainId);
      if (geckoMeta) providers.push({ name: 'GeckoTerminal', status: 'hit', note: 'supplemented' });
    } catch {
      // non-critical
    }

    return [dexMeta, geckoMeta];
  }

  // ── Holder intelligence layer ──────────────────────────────────────────────

  private async fetchHolderIntelligence(
    chain: Chain,
    address: string,
    meta: TokenMeta,
    rugcheckRisks: any[] | undefined,
    providers: ProviderStatus[],
  ): Promise<HolderMetrics> {
    const metrics: HolderMetrics = {};

    // ── Holder data ────────────────────────────────────────────────────────
    if (chain === 'SOLANA') {
      await this.fetchSolanaHolders(address, rugcheckRisks, metrics, providers);
    } else {
      await this.fetchEvmHolders(address, meta.chainId ?? 'ethereum', metrics, providers);
    }

    // ── Bundle detection ───────────────────────────────────────────────────
    if (chain === 'SOLANA') {
      await this.fetchBundleInfo(address, rugcheckRisks, metrics, providers);
    }

    // ── Lifecycle (pump.fun) ────────────────────────────────────────────────
    if (chain === 'SOLANA') {
      await this.fetchLifecycle(address, metrics, providers);
    }

    // ── Price impact ───────────────────────────────────────────────────────
    await this.fetchPriceImpact(address, chain, metrics, providers);

    // ── Chain TVL context ─────────────────────────────────────────────────
    if (meta.chainId) {
      const ctx = await this.defillama.getChainContext(meta.chainId).catch(() => null);
      if (ctx) {
        metrics.chainContext = ctx;
        providers.push({ name: 'DeFiLlama (TVL)', status: 'hit', note: `TVL 7d: ${ctx.tvl7dChangePct?.toFixed(1)}%` });
      }
    }

    // ── Jupiter organic score (SOL only) ──────────────────────────────────
    if (chain === 'SOLANA') {
      const jupResult = await this.pool.execute('ORGANIC_SCORE', {
        jupiter: () => this.jupiter.getTokenData(address),
      });
      if (jupResult.data) {
        const jd = jupResult.data as any;
        if (jd.organicScore != null) {
          metrics.organicScore = jd.organicScore;
          providers.push({ name: 'Jupiter (organic score)', status: 'hit', note: `score: ${jd.organicScore}` });
        }
      }
    }

    return metrics;
  }

  private async fetchSolanaHolders(
    mint: string,
    rugcheckRisks: any[] | undefined,
    metrics: HolderMetrics,
    providers: ProviderStatus[],
  ): Promise<void> {
    // Try Helius first (fastest), then Solana Tracker (deeper)
    const heliusResult = await this.pool.execute('HOLDER_SOL', {
      helius: () => this.heliusHolders.getHolderMetrics(mint, rugcheckRisks),
    });

    if (heliusResult.status === 'hit' && heliusResult.data) {
      const hd = heliusResult.data as any;
      metrics.top10ConcentrationPct = hd.top10ConcentrationPct;
      metrics.bundleDetected = hd.bundleDetected;
      providers.push({ name: 'Helius (holders)', status: 'hit' });
    }

    // Solana Tracker adds top-100 concentration (deeper)
    if (this.solanaTracker.isAvailable) {
      const stResult = await this.pool.execute('HOLDER_SOL', {
        solana_tracker: () => this.solanaTracker.getHolders(mint),
      });
      if (stResult.status === 'hit' && stResult.data) {
        const sd = stResult.data as any;
        metrics.totalHolders = metrics.totalHolders ?? sd.totalHolders;
        metrics.top10ConcentrationPct = metrics.top10ConcentrationPct ?? sd.top10ConcentrationPct;
        metrics.top100ConcentrationPct = sd.top100ConcentrationPct;
        providers.push({ name: 'Solana Tracker (holders)', status: 'hit' });
      }
    }
  }

  private async fetchEvmHolders(
    address: string,
    chainId: string,
    metrics: HolderMetrics,
    providers: ProviderStatus[],
  ): Promise<void> {
    const result = await this.pool.execute<Record<string, any>>('HOLDER_EVM', {
      etherscan: () => this.etherscan.getTopHolders(chainId, address) as Promise<any>,
      moralis:   () => this.moralis.getEvmHolders(chainId, address) as Promise<any>,
    });
    if (result.status === 'hit' && result.data) {
      const hd = result.data;
      metrics.top10ConcentrationPct = hd['top10Pct'] ?? hd['top10ConcentrationPct'];
      metrics.totalHolders = hd['totalHolders'] ?? undefined;
      providers.push({ name: `${result.providerName} (holders)`, status: 'hit' });
    }
  }

  private async fetchBundleInfo(
    mint: string,
    rugcheckRisks: any[] | undefined,
    metrics: HolderMetrics,
    providers: ProviderStatus[],
  ): Promise<void> {
    // Check RugCheck risks for bundle flag (zero extra HTTP call)
    if (rugcheckRisks?.length) {
      const rcBundle = this.bundleChecker.fromRugcheckRisks(rugcheckRisks);
      if (rcBundle?.detected) {
        metrics.bundleDetected = true;
        metrics.bundleInfo = rcBundle;
        providers.push({ name: 'RugCheck (bundle)', status: 'hit', note: `${rcBundle.bundledSupplyPct?.toFixed(1) ?? '?'}% bundled` });
        return; // RugCheck found it — skip additional calls
      }
    }

    // BundleChecker API → Bitquery fallback
    const result = await this.pool.execute<BundleInfo>('BUNDLE_SOL', {
      bundle_checker: () => this.bundleChecker.getBundleInfo(mint),
      bitquery_bundle: () => this.bitquery.getSolanaBundle(mint),
    });
    if (result.data) {
      metrics.bundleDetected = result.data.detected;
      metrics.bundleInfo = result.data;
      if (result.data.detected) {
        providers.push({
          name: `${result.providerName} (bundle)`,
          status: 'hit',
          note: `${result.data.bundledSupplyPct?.toFixed(1) ?? '?'}% of supply bundled`,
        });
      }
    }
  }

  private async fetchLifecycle(
    mint: string,
    metrics: HolderMetrics,
    providers: ProviderStatus[],
  ): Promise<void> {
    const result = await this.pool.execute<LifecycleInfo>('LIFECYCLE', {
      moralis_lifecycle: () => this.moralis.getPumpLifecycle(mint),
      solana_tracker_lifecycle: () => this.solanaTracker.getLifecycle(mint),
    });
    if (result.data) {
      metrics.lifecycle = result.data;
      providers.push({ name: `${result.providerName} (lifecycle)`, status: 'hit', note: result.data.stage });
    }
  }

  private async fetchPriceImpact(
    address: string,
    chain: Chain,
    metrics: HolderMetrics,
    providers: ProviderStatus[],
  ): Promise<void> {
    const result = await this.pool.execute<PriceImpact>('PRICE_IMPACT', {
      birdeye: () => (chain === 'SOLANA' ? this.birdeye.getPriceImpact(address) : Promise.resolve(null)),
      jupiter_impact: () => (chain === 'SOLANA' ? this.jupiter.getPriceImpact(address) : Promise.resolve(null)),
    });
    if (result.data && (result.data.buy500Usd != null || result.data.buy1000Usd != null)) {
      metrics.priceImpact = result.data;
      providers.push({
        name: `${result.providerName} (price impact)`,
        status: 'hit',
        note: `$1K buy: ${result.data.buy1000Usd?.toFixed(1) ?? '?'}%`,
      });
    }
  }

  // ── Social intelligence ────────────────────────────────────────────────────

  private async fetchSocialIntelligence(
    meta: TokenMeta,
    providers: ProviderStatus[],
  ): Promise<SocialData> {
    const base = await this.social.getData(meta);
    if (base.telegramMembers != null || base.domainAgeDays != null) {
      providers.push({ name: 'Social', status: 'hit' });
    }

    // Wayback Machine website history check
    if (base.websiteUrl) {
      const wb = await this.wayback.checkWebsite(base.websiteUrl).catch(() => null);
      if (wb) {
        base.websiteChanged = wb.changed;
        if (wb.snapshotCount > 0) {
          providers.push({ name: 'Wayback Machine', status: 'hit', note: `${wb.snapshotCount} snapshots` });
        }
      }
    }

    return base;
  }

  // ── Smart money ────────────────────────────────────────────────────────────

  private async fetchSmartMoney(
    address: string,
    chain: Chain,
    providers: ProviderStatus[],
  ): Promise<SmartMoneyResult> {
    // Legacy static wallet check (existing feature)
    const legacy = await this.smartMoney.check(address, chain).catch(() => null);

    // GMGN smart money (SOL) / Arkham entity enrichment
    let gmgnSignals: SmartMoneySignal[] | null = null;
    if (chain === 'SOLANA') {
      const result = await this.pool.execute<SmartMoneySignal[]>('SMART_MONEY', {
        gmgn: () => this.gmgn.getSmartMoneySignals(address, 'sol'),
      });
      gmgnSignals = result.data;
    }

    // Arkham enrichment for flagged wallet addresses
    if (gmgnSignals?.length) {
      const wallets = gmgnSignals.map((s) => s.walletAddress).filter(Boolean);
      gmgnSignals = await this.arkham.enrichWallets(wallets, gmgnSignals).catch(() => gmgnSignals!);
    }

    const allSignals = gmgnSignals ?? [];
    if (allSignals.length) {
      providers.push({ name: 'GMGN (smart money)', status: 'hit', note: `${allSignals.length} smart wallet(s) found` });
    }

    return {
      walletsChecked: legacy?.walletsChecked ?? allSignals.length,
      holdersFound: legacy?.holdersFound ?? allSignals.length,
      holders: [
        ...(legacy?.holders ?? []),
        ...allSignals.map((s) => ({ label: s.label ?? s.walletAddress.slice(0, 8) + '...', address: s.walletAddress, winRate: s.winRate })),
      ],
      signals: allSignals,
    };
  }

  // ── Safety ────────────────────────────────────────────────────────────────

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
          providerEntries.push({ name: `GoPlus (${chainName})`, status: 'miss' });
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
            const top10 = rc.topHolders.slice(0, 10).reduce((s: number, h: any) => s + (Number(h.pct) || 0), 0);
            if (Number.isFinite(top10)) out.topHoldersPct = top10;
          }
          if (rc.markets && Array.isArray(rc.markets)) {
            const locked = rc.markets.some((m: any) => m?.lpLocked === true || m?.lpLockedPct === 100);
            out.lpLocked = locked ? 'yes' : 'no';
          }
        } else {
          providerEntries.push({ name: 'RugCheck', status: 'miss' });
        }
      } catch (e: any) {
        this.logger.warn(`RugCheck failed: ${e?.message}`);
        providerEntries.push({ name: 'RugCheck', status: 'error', note: e?.message });
      }
    }

    return { signals: out, providerEntries, rugcheckRisks };
  }

  // ── Merge helpers ──────────────────────────────────────────────────────────

  private mergeTokenMeta(dexMeta: TokenMeta | null, geckoMeta: any, safety: SafetySignals): TokenMeta {
    const merged: TokenMeta = dexMeta ?? { chain: 'SOLANA', address: '', priceChange: {} };
    if (geckoMeta) {
      merged.symbol       = merged.symbol       ?? geckoMeta.symbol;
      merged.name         = merged.name         ?? geckoMeta.name;
      merged.priceUsd     = merged.priceUsd     ?? geckoMeta.priceUsd;
      merged.marketCapUsd = merged.marketCapUsd ?? geckoMeta.marketCapUsd;
      merged.fdvUsd       = merged.fdvUsd       ?? geckoMeta.fdvUsd;
      merged.volume24hUsd = merged.volume24hUsd ?? geckoMeta.volume24hUsd;
      merged.priceChange  = { ...(geckoMeta.priceChange ?? {}), ...merged.priceChange };
      if (safety.holdersCount == null && geckoMeta.holdersCount != null) safety.holdersCount = geckoMeta.holdersCount;
    }
    return merged;
  }

  // ── DB cache ───────────────────────────────────────────────────────────────

  private async loadFromDb(chain: Chain, address: string): Promise<TokenAnalysisReport | null> {
    try {
      const record = await this.prisma.tokenIntel.findFirst({
        where: { chain: chain as any, address, aiAnalyzedAt: { gte: new Date(Date.now() - this.dbCacheTtlMs) } },
        orderBy: { aiAnalyzedAt: 'desc' },
      });
      return record?.fullReport ? (record.fullReport as unknown as TokenAnalysisReport) : null;
    } catch {
      return null;
    }
  }

  private async persistToDb(chain: Chain, address: string, report: TokenAnalysisReport): Promise<void> {
    try {
      const ai = report.aiReasoning;
      const j = (v: unknown) => (v != null ? (v as any) : undefined);
      const payload = {
        symbol: report.meta.symbol,
        name: report.meta.name,
        aiScore: ai?.score,
        aiVerdict: ai?.verdict,
        aiSummary: ai?.summary,
        aiReasoning: j(ai),
        killTriggered: report.kill?.triggered ?? false,
        killReason: report.kill?.reason,
        holderMetrics: j(report.holderMetrics),
        socialData: j(report.socialData),
        smartMoneyData: j(report.smartMoney),
        fullReport: j(report),
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

  // ── Report builder ────────────────────────────────────────────────────────

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
        'qwai analysis is informational only, not financial advice. ' +
        'Free-tier data sources used; some signals are heuristic.',
      kill: kill.triggered ? kill : undefined,
      holderMetrics,
      socialData,
      smartMoney,
      aiReasoning,
    };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function numOrU(v: any): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function toBps(v: any): number | undefined {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10000) : undefined;
}
function computeTopHoldersPct(gp: any): number | undefined {
  if (!Array.isArray(gp?.holders)) return undefined;
  const sum = gp.holders.slice(0, 10).reduce((s: number, h: any) => s + (Number(h?.percent) || 0), 0);
  return Number.isFinite(sum) ? Math.min(100, sum * 100) : undefined;
}
function lpLockedFromHolders(holders: any[]): 'yes' | 'no' | 'unknown' {
  if (!Array.isArray(holders)) return 'unknown';
  return holders.some((h) => h?.is_locked === '1' || h?.is_locked === 1) ? 'yes' : 'no';
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
