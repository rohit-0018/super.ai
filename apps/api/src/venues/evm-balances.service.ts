/**
 * Multi-chain EVM balances with RPC failover.
 *
 * Fixes two concrete bugs in the previous wallet balance path
 * (wallets.service.ts fetchEvmBalance / fetchOnChainBalance):
 *
 *  1. It built ONE provider from `getEvmRpcUrl()` — Ethereum mainnet — and used
 *     it for every EVM wallet. An address funded on Base or Arbitrum reported a
 *     zero balance, because its ETH is on a different chain. Verified during
 *     development: one address held 3.13 ETH on Base and 0.159 ETH on Arbitrum
 *     while the Ethereum query returned nothing.
 *  2. Symbol and price were hardcoded to ETH/`ethereum`, so a BNB or POL balance
 *     was displayed as ETH and valued at the ETH price.
 *
 * A single EVM address is valid on every EVM chain, so the correct model is to
 * fan out across all of them and return a per-chain breakdown.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ethers } from 'ethers';
import { ALL_CHAINS, getChain, type ChainKey, type ChainSpec } from './chain-registry';
import { NativePriceService } from './native-price.service';

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

const RPC_TIMEOUT_MS = 8_000;
/**
 * Portfolio cache lifetime. Balances move on block time (2s on most L2s), but
 * the wallets screen re-reads on every render and poll; 12s keeps the display
 * live while collapsing bursts into one round of RPC calls.
 */
const PORTFOLIO_TTL_MS = Number(process.env.EVM_PORTFOLIO_TTL_MS ?? 12_000);

export interface ChainNativeBalance {
  chain: ChainKey;
  chainName: string;
  symbol: string;
  native: number;
  usd: number;
  explorerUrl: string;
  /** Set when every RPC for this chain failed — distinguishes "error" from "zero". */
  error?: string;
}

export interface EvmPortfolio {
  address: string;
  chains: ChainNativeBalance[];
  totalUsd: number;
  at: string;
}

@Injectable()
export class EvmBalancesService {
  private readonly logger = new Logger(EvmBalancesService.name);
  /** Provider that last worked for a chain, so we don't re-probe a dead RPC. */
  private working = new Map<ChainKey, ethers.JsonRpcProvider>();
  /** In-flight provider probes, shared so concurrent callers don't stampede. */
  private probing = new Map<ChainKey, Promise<ethers.JsonRpcProvider>>();
  private portfolioCache = new Map<string, { value: EvmPortfolio; at: number }>();
  private portfolioInflight = new Map<string, Promise<EvmPortfolio>>();

  constructor(private readonly nativePrice: NativePriceService) {}

  /**
   * Every EVM chain's native balance for one address, priced in USD.
   *
   * Cached and de-duplicated: one portfolio is 8 chains of RPC calls, and the
   * wallets screen asks for every wallet at once. Without this a page with 6 EVM
   * wallets fired 48 concurrent RPC calls on each refresh, and a re-render
   * within the same second fired them all again.
   */
  async portfolio(address: string): Promise<EvmPortfolio> {
    const key = address.toLowerCase();

    const hit = this.portfolioCache.get(key);
    if (hit && Date.now() - hit.at < PORTFOLIO_TTL_MS) return hit.value;

    const existing = this.portfolioInflight.get(key);
    if (existing) return existing;

    const p = this.computePortfolio(address)
      .then((value) => {
        this.portfolioCache.set(key, { value, at: Date.now() });
        return value;
      })
      .finally(() => this.portfolioInflight.delete(key));

    this.portfolioInflight.set(key, p);
    return p;
  }

  private async computePortfolio(address: string): Promise<EvmPortfolio> {
    const evmChains = ALL_CHAINS.filter((c) => c.family === 'EVM');

    const chains = await Promise.all(
      evmChains.map(async (spec): Promise<ChainNativeBalance> => {
        const base = {
          chain: spec.key,
          chainName: spec.displayName,
          symbol: spec.nativeSymbol,
          explorerUrl: spec.explorerAddressUrl(address),
        };
        try {
          const [native, priceUsd] = await Promise.all([
            this.nativeBalance(spec, address),
            this.nativePrice.priceFor(spec).catch(() => 0),
          ]);
          return { ...base, native, usd: native * priceUsd };
        } catch (e: any) {
          // Surface the failure rather than reporting a misleading 0.00.
          return { ...base, native: 0, usd: 0, error: e?.message ?? 'rpc failed' };
        }
      }),
    );

    return {
      address,
      chains,
      totalUsd: chains.reduce((s, c) => s + c.usd, 0),
      at: new Date().toISOString(),
    };
  }

  /** Native balance on one chain, as a decimal number. */
  async nativeBalance(chain: ChainKey | ChainSpec, address: string): Promise<number> {
    const spec = typeof chain === 'string' ? getChain(chain) : chain;
    const wei = await this.withProvider(spec, (p) => p.getBalance(address));
    return Number(ethers.formatUnits(wei, spec.nativeDecimals));
  }

  /** ERC-20 balance for a specific token. Returns null when the wallet holds none. */
  async tokenBalance(
    chain: ChainKey | ChainSpec,
    address: string,
    token: string,
  ): Promise<{ raw: string; balance: number; decimals: number; symbol?: string } | null> {
    const spec = typeof chain === 'string' ? getChain(chain) : chain;
    try {
      return await this.withProvider(spec, async (provider) => {
        const erc20 = new ethers.Contract(token, ERC20_ABI, provider);
        const [raw, decimals, symbol] = await Promise.all([
          erc20.balanceOf(address) as Promise<bigint>,
          erc20.decimals() as Promise<bigint>,
          (erc20.symbol() as Promise<string>).catch(() => undefined),
        ]);
        if (raw === 0n) return null;
        const dec = Number(decimals);
        return {
          raw: raw.toString(),
          balance: Number(ethers.formatUnits(raw, dec)),
          decimals: dec,
          symbol,
        };
      });
    } catch (e: any) {
      this.logger.warn(`tokenBalance failed ${token}@${spec.key}: ${e?.message}`);
      return null;
    }
  }

  /**
   * Balances for a known token list across one chain. Deliberately takes an
   * explicit list: enumerating an address's ERC-20 holdings is impossible from
   * a plain RPC and needs a keyed indexer. Callers pass the tokens qwai already
   * knows the user traded, which covers the case that matters without adding a
   * paid dependency.
   */
  async tokenBalances(chain: ChainKey | ChainSpec, address: string, tokens: string[]) {
    const results = await Promise.all(
      tokens.map(async (t) => {
        const bal = await this.tokenBalance(chain, address, t);
        return bal ? { token: t, ...bal } : null;
      }),
    );
    return results.filter((r): r is NonNullable<typeof r> => r != null);
  }

  /**
   * Runs `fn` against the first RPC that answers, remembering the winner.
   *
   * Public RPCs fail often and in varied ways (521s, rate limits, timeouts), and
   * a failure here is dangerous precisely because ethers surfaces some of them
   * as a successful zero. Trying each candidate in turn and throwing when all
   * are exhausted keeps "chain unreachable" distinguishable from "balance is 0".
   */
  private async withProvider<T>(
    spec: ChainSpec,
    fn: (p: ethers.JsonRpcProvider) => Promise<T>,
  ): Promise<T> {
    const cached = this.working.get(spec.key);
    if (cached) {
      try {
        return await this.withTimeout(fn(cached));
      } catch {
        // Cached endpoint went bad — fall through and re-probe the full list.
        this.working.delete(spec.key);
      }
    }

    // Probe once per chain even when many callers arrive together. Six wallets
    // hitting eight chains used to launch 48 independent probes against the same
    // handful of public endpoints — enough to get rate-limited on the spot.
    const provider = await this.resolveProvider(spec);
    return this.withTimeout(fn(provider));
  }

  /** Resolves (and memoizes) a working provider for a chain. */
  private resolveProvider(spec: ChainSpec): Promise<ethers.JsonRpcProvider> {
    const cached = this.working.get(spec.key);
    if (cached) return Promise.resolve(cached);

    const inflight = this.probing.get(spec.key);
    if (inflight) return inflight;

    const envOverride = process.env[spec.rpcEnvVar];
    const candidates = [
      ...(envOverride ? [envOverride] : []),
      spec.defaultRpcUrl,
      ...spec.fallbackRpcUrls,
    ];

    const probe = (async () => {
      const errors: string[] = [];
      for (const url of candidates) {
        try {
          // staticNetwork avoids an extra eth_chainId round-trip per provider.
          const provider = new ethers.JsonRpcProvider(url, spec.evmChainId, {
            staticNetwork: true,
          });
          // A cheap liveness call — proves the endpoint answers before we
          // commit every subsequent balance read to it.
          await this.withTimeout(provider.getBlockNumber());
          this.working.set(spec.key, provider);
          return provider;
        } catch (e: any) {
          errors.push(`${hostOf(url)}: ${e?.message ?? 'failed'}`);
        }
      }
      throw new Error(`all RPCs failed for ${spec.key} — ${errors.join('; ')}`);
    })().finally(() => this.probing.delete(spec.key));

    this.probing.set(spec.key, probe);
    return probe;
  }

  private withTimeout<T>(p: Promise<T>): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_, rej) =>
        setTimeout(() => rej(new Error(`timeout after ${RPC_TIMEOUT_MS}ms`)), RPC_TIMEOUT_MS),
      ),
    ]);
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
