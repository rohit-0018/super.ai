import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RateLimitService } from './rate-limit.service';

export interface ProviderEntry {
  key: string;
  displayName: string;
  dataGroup: string;
  priority: number;
  reqsPerWindow: number;
  windowSec: number;
  cooldownSec: number;
  enabled: boolean;
  requiresKey: string | null;
}

export interface ExecuteResult<T> {
  data: T | null;
  providerKey: string | null;
  providerName: string | null;
  status: 'hit' | 'miss' | 'exhausted' | 'skipped';
}

const CACHE_TTL_MS = 5 * 60 * 1000; // re-read DB every 5 min

/**
 * Manages provider selection with rate-limit awareness and automatic fallback.
 *
 * Usage:
 *   const result = await pool.execute('MARKET_DATA', {
 *     dexscreener: () => dexscreener.getToken(chain, address),
 *     geckoterminal: () => gecko.getToken(chain, address),
 *   });
 *
 * The pool tries providers in ascending priority order, skipping any that are
 * currently rate-limited (cooldown active or window exhausted). On a 429
 * response it marks the provider as cooling-down and tries the next one.
 *
 * Provider configs are loaded from the `ProviderConfig` Postgres table (seeded
 * once at startup by ProviderPoolSeed) and cached in memory for 5 minutes.
 */
@Injectable()
export class ProviderPoolService implements OnModuleInit {
  private readonly logger = new Logger(ProviderPoolService.name);
  private cache = new Map<string, { providers: ProviderEntry[]; ts: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly rl: RateLimitService,
  ) {}

  async onModuleInit() {
    // Warm the cache on boot so the first request isn't cold
    await this.seedDefaultsIfEmpty();
    await this.getGroupProviders('_all');
  }

  /**
   * Execute handlers in provider-priority order, respecting rate limits.
   * handlers: map of providerKey → async factory. Keys not in the map are skipped.
   */
  async execute<T>(
    group: string,
    handlers: Record<string, () => Promise<T | null>>,
  ): Promise<ExecuteResult<T>> {
    const providers = await this.getGroupProviders(group);
    const available = providers.filter(
      (p) => p.enabled && handlers[p.key] && this.isKeyPresent(p.requiresKey),
    );

    for (const provider of available) {
      const canUse = await this.rl.canUse(provider.key, provider.reqsPerWindow, provider.windowSec);
      if (!canUse) {
        this.logger.debug(`Provider [${provider.key}] rate-limited — skipping`);
        continue;
      }

      try {
        const data = await handlers[provider.key]();
        await this.rl.record(provider.key, provider.windowSec);
        if (data !== null && data !== undefined) {
          return { data, providerKey: provider.key, providerName: provider.displayName, status: 'hit' };
        }
        return { data: null, providerKey: provider.key, providerName: provider.displayName, status: 'miss' };
      } catch (e: any) {
        if (this.isRateLimitError(e)) {
          await this.rl.markCooldown(provider.key, provider.cooldownSec);
          this.logger.warn(`Provider [${provider.key}] 429 — cooling down ${provider.cooldownSec}s, trying next`);
          continue;
        }
        // Any other error: log and try next provider
        this.logger.warn(`Provider [${provider.key}] error: ${e.message} — trying fallback`);
        continue;
      }
    }

    return { data: null, providerKey: null, providerName: null, status: 'exhausted' };
  }

  /**
   * Like execute() but tries ALL available providers and merges results.
   * Use for enrichment where multiple sources contribute different fields.
   */
  async executeAll<T>(
    group: string,
    handlers: Record<string, () => Promise<T | null>>,
    merge: (acc: Partial<T>, next: T) => Partial<T>,
  ): Promise<{ data: Partial<T>; providers: string[] }> {
    const providers = await this.getGroupProviders(group);
    const available = providers.filter(
      (p) => p.enabled && handlers[p.key] && this.isKeyPresent(p.requiresKey),
    );

    let acc: Partial<T> = {};
    const hit: string[] = [];

    await Promise.allSettled(
      available.map(async (provider) => {
        const canUse = await this.rl.canUse(provider.key, provider.reqsPerWindow, provider.windowSec);
        if (!canUse) return;
        try {
          const data = await handlers[provider.key]();
          if (data) {
            await this.rl.record(provider.key, provider.windowSec);
            acc = merge(acc, data);
            hit.push(provider.key);
          }
        } catch (e: any) {
          if (this.isRateLimitError(e)) {
            await this.rl.markCooldown(provider.key, provider.cooldownSec);
          }
        }
      }),
    );

    return { data: acc, providers: hit };
  }

  /**
   * Manually mark a provider as rate-limited (call after detecting 429 outside execute()).
   */
  async markRateLimited(key: string): Promise<void> {
    const providers = await this.getGroupProviders('_all');
    const p = providers.find((x) => x.key === key);
    await this.rl.markCooldown(key, p?.cooldownSec ?? 120);
  }

  /**
   * Get live status of all providers across all groups. Used by admin endpoint.
   */
  async getAllStatus(): Promise<
    Array<ProviderEntry & { available: boolean; used: number; remaining: number; cooldownTtl: number }>
  > {
    const providers = await this.getGroupProviders('_all');
    return Promise.all(
      providers.map(async (p) => {
        const s = await this.rl.getStatus(p.key, p.reqsPerWindow, p.windowSec);
        return { ...p, ...s };
      }),
    );
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async getGroupProviders(group: string): Promise<ProviderEntry[]> {
    const cached = this.cache.get(group);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.providers;

    try {
      const rows = await this.prisma.providerConfig.findMany({
        where: group === '_all' ? {} : { dataGroup: group },
        orderBy: [{ priority: 'asc' }, { key: 'asc' }],
      });
      const providers: ProviderEntry[] = rows.map((r) => ({
        key: r.key,
        displayName: r.displayName,
        dataGroup: r.dataGroup,
        priority: r.priority,
        reqsPerWindow: r.reqsPerWindow,
        windowSec: r.windowSec,
        cooldownSec: r.cooldownSec,
        enabled: r.enabled,
        requiresKey: r.requiresKey,
      }));
      this.cache.set(group, { providers, ts: Date.now() });
      return providers;
    } catch (e: any) {
      this.logger.warn(`Could not load provider config from DB: ${e.message} — using empty list`);
      return [];
    }
  }

  private isKeyPresent(requiresKey: string | null): boolean {
    if (!requiresKey) return true;
    const val = process.env[requiresKey];
    return !!val && val.trim() !== '';
  }

  private isRateLimitError(e: any): boolean {
    return (
      e?.status === 429 ||
      e?.statusCode === 429 ||
      /429|rate.?limit|too many/i.test(e?.message ?? '')
    );
  }

  /** Seeds the ProviderConfig table with defaults if it is empty. */
  private async seedDefaultsIfEmpty(): Promise<void> {
    try {
      const count = await this.prisma.providerConfig.count();
      if (count > 0) return;
      this.logger.log('Seeding ProviderConfig defaults...');
      await this.prisma.providerConfig.createMany({ data: DEFAULT_PROVIDERS, skipDuplicates: true });
      this.logger.log(`Seeded ${DEFAULT_PROVIDERS.length} provider configs`);
    } catch (e: any) {
      this.logger.warn(`Provider seed failed: ${e.message}`);
    }
  }
}

// ── Default provider seed data ────────────────────────────────────────────────
// Edit rows in the DB (or update this array + restart) to tune limits.

const DEFAULT_PROVIDERS: Array<{
  key: string;
  displayName: string;
  dataGroup: string;
  priority: number;
  reqsPerWindow: number;
  windowSec: number;
  cooldownSec: number;
  enabled: boolean;
  requiresKey: string | null;
  baseUrl: string | null;
  notes: string | null;
}> = [
  // ── MARKET DATA ─────────────────────────────────────────────────────────
  { key: 'dexscreener',    displayName: 'DexScreener',    dataGroup: 'MARKET_DATA', priority: 10, reqsPerWindow: 280, windowSec: 60, cooldownSec: 30,  enabled: true,  requiresKey: null,                   baseUrl: 'https://api.dexscreener.com', notes: '300/min soft limit' },
  { key: 'geckoterminal',  displayName: 'GeckoTerminal',  dataGroup: 'MARKET_DATA', priority: 20, reqsPerWindow: 25,  windowSec: 60, cooldownSec: 60,  enabled: true,  requiresKey: null,                   baseUrl: 'https://api.geckoterminal.com', notes: 'No stated limit; conservative 25/min' },
  { key: 'coingecko',      displayName: 'CoinGecko',      dataGroup: 'MARKET_DATA', priority: 30, reqsPerWindow: 28,  windowSec: 60, cooldownSec: 90,  enabled: true,  requiresKey: null,                   baseUrl: 'https://api.coingecko.com', notes: '30/min free tier' },
  // ── SAFETY — SOLANA ─────────────────────────────────────────────────────
  { key: 'rugcheck',       displayName: 'RugCheck',       dataGroup: 'SAFETY_SOL',  priority: 10, reqsPerWindow: 55,  windowSec: 60, cooldownSec: 60,  enabled: true,  requiresKey: null,                   baseUrl: 'https://api.rugcheck.xyz', notes: 'No stated limit; conservative' },
  { key: 'solana_tracker_safety', displayName: 'Solana Tracker (safety)', dataGroup: 'SAFETY_SOL', priority: 20, reqsPerWindow: 55, windowSec: 60, cooldownSec: 60, enabled: true, requiresKey: 'SOLANA_TRACKER_API_KEY', baseUrl: 'https://data.solanatracker.io', notes: 'Free tier with key' },
  // ── SAFETY — EVM ────────────────────────────────────────────────────────
  { key: 'goplus',         displayName: 'GoPlus Security', dataGroup: 'SAFETY_EVM', priority: 10, reqsPerWindow: 290, windowSec: 60, cooldownSec: 60,  enabled: true,  requiresKey: null,                   baseUrl: 'https://api.gopluslabs.io', notes: 'Free, high limit' },
  { key: 'defi_scanner',   displayName: 'De.Fi Scanner',  dataGroup: 'SAFETY_EVM',  priority: 20, reqsPerWindow: 25,  windowSec: 60, cooldownSec: 120, enabled: true,  requiresKey: null,                   baseUrl: 'https://de.fi', notes: 'Free, conservative limit' },
  // ── HOLDER DATA — SOLANA ────────────────────────────────────────────────
  { key: 'helius',         displayName: 'Helius RPC',     dataGroup: 'HOLDER_SOL',  priority: 10, reqsPerWindow: 550, windowSec: 60, cooldownSec: 30,  enabled: true,  requiresKey: 'HELIUS_RPC_URL',       baseUrl: null, notes: '10 RPS free tier' },
  { key: 'solana_tracker', displayName: 'Solana Tracker', dataGroup: 'HOLDER_SOL',  priority: 20, reqsPerWindow: 55,  windowSec: 60, cooldownSec: 60,  enabled: true,  requiresKey: 'SOLANA_TRACKER_API_KEY', baseUrl: 'https://data.solanatracker.io', notes: 'Top-100 holders + risk' },
  { key: 'bitquery_holder',displayName: 'Bitquery (holders)', dataGroup: 'HOLDER_SOL', priority: 30, reqsPerWindow: 2, windowSec: 60, cooldownSec: 300, enabled: true, requiresKey: 'BITQUERY_API_KEY',     baseUrl: 'https://streaming.bitquery.io', notes: '10K pts/mo — use sparingly' },
  // ── HOLDER DATA — EVM ────────────────────────────────────────────────────
  { key: 'etherscan',      displayName: 'Etherscan',      dataGroup: 'HOLDER_EVM',  priority: 10, reqsPerWindow: 270, windowSec: 60, cooldownSec: 60,  enabled: true,  requiresKey: 'ETHERSCAN_API_KEY',    baseUrl: 'https://api.etherscan.io', notes: '5/sec = 300/min free' },
  { key: 'moralis',        displayName: 'Moralis',        dataGroup: 'HOLDER_EVM',  priority: 20, reqsPerWindow: 1000, windowSec: 60, cooldownSec: 60, enabled: true,  requiresKey: 'MORALIS_API_KEY',      baseUrl: 'https://deep-index.moralis.io', notes: '25 req/sec free tier' },
  { key: 'intotheblock',   displayName: 'IntoTheBlock',   dataGroup: 'HOLDER_EVM',  priority: 30, reqsPerWindow: 25,  windowSec: 60, cooldownSec: 120, enabled: true,  requiresKey: null,                   baseUrl: 'https://api.intotheblock.com', notes: 'Free basic tier' },
  // ── BUNDLE DETECTION ─────────────────────────────────────────────────────
  { key: 'bundle_checker', displayName: 'BundleChecker',  dataGroup: 'BUNDLE_SOL',  priority: 10, reqsPerWindow: 20,  windowSec: 60, cooldownSec: 120, enabled: true,  requiresKey: null,                   baseUrl: 'https://trench.bot', notes: 'Web scrape — fragile, use sparingly' },
  { key: 'bitquery_bundle',displayName: 'Bitquery (bundles)', dataGroup: 'BUNDLE_SOL', priority: 20, reqsPerWindow: 2, windowSec: 60, cooldownSec: 300, enabled: true, requiresKey: 'BITQUERY_API_KEY',     baseUrl: 'https://streaming.bitquery.io', notes: '10K pts/mo quota guard' },
  // ── PUMP.FUN LIFECYCLE ───────────────────────────────────────────────────
  { key: 'moralis_lifecycle', displayName: 'Moralis (lifecycle)', dataGroup: 'LIFECYCLE', priority: 10, reqsPerWindow: 1000, windowSec: 60, cooldownSec: 60, enabled: true, requiresKey: 'MORALIS_API_KEY', baseUrl: 'https://deep-index.moralis.io', notes: 'pump.fun bonding + graduation' },
  { key: 'solana_tracker_lifecycle', displayName: 'Solana Tracker (lifecycle)', dataGroup: 'LIFECYCLE', priority: 20, reqsPerWindow: 55, windowSec: 60, cooldownSec: 60, enabled: true, requiresKey: 'SOLANA_TRACKER_API_KEY', baseUrl: 'https://data.solanatracker.io', notes: 'Graduated token feed' },
  // ── PRICE IMPACT ─────────────────────────────────────────────────────────
  { key: 'birdeye',        displayName: 'Birdeye',        dataGroup: 'PRICE_IMPACT', priority: 10, reqsPerWindow: 9,   windowSec: 60, cooldownSec: 120, enabled: true,  requiresKey: 'BIRDEYE_API_KEY',      baseUrl: 'https://public-api.birdeye.so', notes: '10 req/min free tier' },
  { key: 'jupiter_impact', displayName: 'Jupiter (impact)', dataGroup: 'PRICE_IMPACT', priority: 20, reqsPerWindow: 280, windowSec: 60, cooldownSec: 30, enabled: true,  requiresKey: null,                   baseUrl: 'https://lite-api.jup.ag', notes: 'Quote API for impact simulation' },
  // ── ORGANIC SCORE / TOKEN QUALITY ────────────────────────────────────────
  { key: 'jupiter',        displayName: 'Jupiter',        dataGroup: 'ORGANIC_SCORE', priority: 10, reqsPerWindow: 280, windowSec: 60, cooldownSec: 30, enabled: true, requiresKey: null,                    baseUrl: 'https://lite-api.jup.ag', notes: 'Organic score + verified flag' },
  { key: 'birdeye_organic',displayName: 'Birdeye (organic)', dataGroup: 'ORGANIC_SCORE', priority: 20, reqsPerWindow: 9, windowSec: 60, cooldownSec: 120, enabled: true, requiresKey: 'BIRDEYE_API_KEY',    baseUrl: 'https://public-api.birdeye.so', notes: 'Trader count + unique wallets' },
  // ── SMART MONEY ──────────────────────────────────────────────────────────
  { key: 'gmgn',           displayName: 'GMGN',           dataGroup: 'SMART_MONEY',  priority: 10, reqsPerWindow: 10,  windowSec: 60, cooldownSec: 300, enabled: true,  requiresKey: null,                   baseUrl: 'https://gmgn.ai', notes: 'Scraper — aggressive cooldown' },
  { key: 'arkham',         displayName: 'Arkham Intel',   dataGroup: 'SMART_MONEY',  priority: 20, reqsPerWindow: 20,  windowSec: 60, cooldownSec: 120, enabled: true,  requiresKey: null,                   baseUrl: 'https://api.arkham.intelligence', notes: 'Entity labels free tier' },
  { key: 'debank',         displayName: 'DeBank',         dataGroup: 'SMART_MONEY',  priority: 30, reqsPerWindow: 25,  windowSec: 60, cooldownSec: 120, enabled: true,  requiresKey: null,                   baseUrl: 'https://pro-openapi.debank.com', notes: 'Wallet portfolio lookup' },
  // ── SOCIAL ────────────────────────────────────────────────────────────────
  { key: 'telegram',       displayName: 'Telegram Bot API', dataGroup: 'SOCIAL_TG', priority: 10, reqsPerWindow: 28,  windowSec: 60, cooldownSec: 60,  enabled: true,  requiresKey: 'TELEGRAM_BOT_TOKEN',   baseUrl: 'https://api.telegram.org', notes: '30/min per bot' },
  { key: 'snscrape',       displayName: 'snscrape (Twitter)', dataGroup: 'SOCIAL_TWITTER', priority: 10, reqsPerWindow: 5, windowSec: 60, cooldownSec: 300, enabled: false, requiresKey: null,                baseUrl: null, notes: 'Disabled by default — needs Python env' },
  // ── CHAIN TVL / MACRO ────────────────────────────────────────────────────
  { key: 'defillama',      displayName: 'DeFiLlama',      dataGroup: 'CHAIN_TVL',   priority: 10, reqsPerWindow: 290, windowSec: 60, cooldownSec: 30,  enabled: true,  requiresKey: null,                   baseUrl: 'https://api.llama.fi', notes: 'Free unlimited' },
  // ── DOMAIN / WEBSITE ────────────────────────────────────────────────────
  { key: 'rdap',           displayName: 'RDAP.org',       dataGroup: 'DOMAIN_CHECK', priority: 10, reqsPerWindow: 25,  windowSec: 60, cooldownSec: 60,  enabled: true,  requiresKey: null,                   baseUrl: 'https://rdap.org', notes: 'WHOIS-over-HTTP, no auth' },
  { key: 'wayback',        displayName: 'Wayback Machine', dataGroup: 'DOMAIN_CHECK', priority: 20, reqsPerWindow: 10, windowSec: 60, cooldownSec: 120, enabled: true,  requiresKey: null,                   baseUrl: 'https://archive.org', notes: 'Historical snapshot check' },
];
