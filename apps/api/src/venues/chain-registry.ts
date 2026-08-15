/**
 * Single source of truth for every chain qwai can see or trade on.
 *
 * Why this file exists: the same chain is named differently by every provider we
 * use. DexScreener says `ethereum`, GeckoTerminal says `eth`, CoinGecko says
 * `ethereum` for the platform but `weth` for the asset. Polygon is `polygon` /
 * `polygon_pos` / `polygon-pos`. Avalanche is `avalanche` / `avax` / `avalanche`.
 * Before this registry every provider carried its own ad-hoc mapping (see the
 * inline EVM_CHAINS Set that used to live in dexscreener.provider.ts), which is
 * why adding a chain meant touching a dozen files.
 *
 * Everything here is static data — no network, no env, no DB. That keeps it
 * trivially unit-testable and safe to import from anywhere including workers.
 *
 * `family` maps back to the Prisma `Chain` enum (SOLANA | EVM) so this registry
 * can be adopted incrementally without a destructive schema migration: existing
 * rows keep their coarse family, new code reads the precise `key`.
 */

export type ChainFamily = 'SOLANA' | 'EVM';

/** Canonical chain key. Stable across providers — this is what we persist. */
export type ChainKey =
  | 'solana'
  | 'ethereum'
  | 'bsc'
  | 'base'
  | 'arbitrum'
  | 'polygon'
  | 'avalanche'
  | 'optimism'
  | 'blast';

export interface ChainSpec {
  key: ChainKey;
  family: ChainFamily;
  displayName: string;
  /** EVM numeric chain id. Undefined for non-EVM families. */
  evmChainId?: number;
  /** Native gas asset symbol. */
  nativeSymbol: string;
  nativeDecimals: number;
  /** Wrapped native — what DEX routers actually quote against. */
  wrappedNative: string;
  /** Canonical USDC on this chain. Used as the default quote asset. */
  usdc: string;
  /** Provider-specific identifiers. Keyed by our provider names. */
  ids: {
    /** DexScreener `chainId` field. */
    dexscreener: string;
    /** GeckoTerminal network slug (`/networks/{slug}/...`). */
    geckoterminal: string;
    /** CoinGecko asset-platform id (`/coins/{platform}/contract/{addr}`). */
    coingecko: string;
    /** DeFiLlama chain slug. */
    defillama: string;
  };
  /** Free public RPC. Overridable per-chain via env (see rpcEnvVar). */
  defaultRpcUrl: string;
  /**
   * Additional free RPCs tried in order when the default fails. Public
   * endpoints go down regularly — eth.llamarpc.com was returning 521 during
   * development — so a single hardcoded URL makes balances silently read zero.
   */
  fallbackRpcUrls: string[];
  rpcEnvVar: string;
  explorerTxUrl: (hash: string) => string;
  explorerAddressUrl: (addr: string) => string;
  /** Which spot router we use to swap here. */
  spotRouter: 'jupiter' | 'oneinch';
  /** Rough block time in ms — used to size confirmation timeouts. */
  blockTimeMs: number;
}

const CHAINS: Record<ChainKey, ChainSpec> = {
  solana: {
    key: 'solana',
    family: 'SOLANA',
    displayName: 'Solana',
    nativeSymbol: 'SOL',
    nativeDecimals: 9,
    wrappedNative: 'So11111111111111111111111111111111111111112',
    usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    ids: {
      dexscreener: 'solana',
      geckoterminal: 'solana',
      coingecko: 'solana',
      defillama: 'solana',
    },
    defaultRpcUrl: 'https://api.mainnet-beta.solana.com',
    fallbackRpcUrls: ['https://solana-rpc.publicnode.com', 'https://rpc.ankr.com/solana'],
    rpcEnvVar: 'SOLANA_RPC_URL',
    explorerTxUrl: (h) => `https://solscan.io/tx/${h}`,
    explorerAddressUrl: (a) => `https://solscan.io/account/${a}`,
    spotRouter: 'jupiter',
    blockTimeMs: 400,
  },

  ethereum: {
    key: 'ethereum',
    family: 'EVM',
    displayName: 'Ethereum',
    evmChainId: 1,
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    wrappedNative: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    ids: {
      dexscreener: 'ethereum',
      geckoterminal: 'eth',
      coingecko: 'ethereum',
      defillama: 'ethereum',
    },
    defaultRpcUrl: 'https://eth.llamarpc.com',
    fallbackRpcUrls: ['https://ethereum-rpc.publicnode.com', 'https://rpc.ankr.com/eth', 'https://cloudflare-eth.com'],
    rpcEnvVar: 'EVM_RPC_URL',
    explorerTxUrl: (h) => `https://etherscan.io/tx/${h}`,
    explorerAddressUrl: (a) => `https://etherscan.io/address/${a}`,
    spotRouter: 'oneinch',
    blockTimeMs: 12_000,
  },

  bsc: {
    key: 'bsc',
    family: 'EVM',
    displayName: 'BNB Chain',
    evmChainId: 56,
    nativeSymbol: 'BNB',
    nativeDecimals: 18,
    wrappedNative: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    usdc: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    ids: {
      dexscreener: 'bsc',
      geckoterminal: 'bsc',
      coingecko: 'binance-smart-chain',
      defillama: 'bsc',
    },
    defaultRpcUrl: 'https://bsc-rpc.publicnode.com',
    fallbackRpcUrls: ['https://bsc-dataseed.binance.org', 'https://bsc-dataseed1.defibit.io'],
    rpcEnvVar: 'BSC_RPC_URL',
    explorerTxUrl: (h) => `https://bscscan.com/tx/${h}`,
    explorerAddressUrl: (a) => `https://bscscan.com/address/${a}`,
    spotRouter: 'oneinch',
    blockTimeMs: 3_000,
  },

  base: {
    key: 'base',
    family: 'EVM',
    displayName: 'Base',
    evmChainId: 8453,
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    wrappedNative: '0x4200000000000000000000000000000000000006',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    ids: {
      dexscreener: 'base',
      geckoterminal: 'base',
      coingecko: 'base',
      defillama: 'base',
    },
    defaultRpcUrl: 'https://mainnet.base.org',
    fallbackRpcUrls: ['https://base-rpc.publicnode.com', 'https://base.llamarpc.com'],
    rpcEnvVar: 'BASE_RPC_URL',
    explorerTxUrl: (h) => `https://basescan.org/tx/${h}`,
    explorerAddressUrl: (a) => `https://basescan.org/address/${a}`,
    spotRouter: 'oneinch',
    blockTimeMs: 2_000,
  },

  arbitrum: {
    key: 'arbitrum',
    family: 'EVM',
    displayName: 'Arbitrum',
    evmChainId: 42161,
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    wrappedNative: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    ids: {
      dexscreener: 'arbitrum',
      geckoterminal: 'arbitrum',
      coingecko: 'arbitrum-one',
      defillama: 'arbitrum',
    },
    defaultRpcUrl: 'https://arb1.arbitrum.io/rpc',
    fallbackRpcUrls: ['https://arbitrum-one-rpc.publicnode.com', 'https://rpc.ankr.com/arbitrum'],
    rpcEnvVar: 'ARBITRUM_RPC_URL',
    explorerTxUrl: (h) => `https://arbiscan.io/tx/${h}`,
    explorerAddressUrl: (a) => `https://arbiscan.io/address/${a}`,
    spotRouter: 'oneinch',
    blockTimeMs: 250,
  },

  polygon: {
    key: 'polygon',
    family: 'EVM',
    displayName: 'Polygon',
    evmChainId: 137,
    nativeSymbol: 'POL',
    nativeDecimals: 18,
    wrappedNative: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
    usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    ids: {
      dexscreener: 'polygon',
      geckoterminal: 'polygon_pos',
      coingecko: 'polygon-pos',
      defillama: 'polygon',
    },
    defaultRpcUrl: 'https://polygon-rpc.com',
    fallbackRpcUrls: ['https://polygon-bor-rpc.publicnode.com', 'https://rpc.ankr.com/polygon'],
    rpcEnvVar: 'POLYGON_RPC_URL',
    explorerTxUrl: (h) => `https://polygonscan.com/tx/${h}`,
    explorerAddressUrl: (a) => `https://polygonscan.com/address/${a}`,
    spotRouter: 'oneinch',
    blockTimeMs: 2_000,
  },

  avalanche: {
    key: 'avalanche',
    family: 'EVM',
    displayName: 'Avalanche',
    evmChainId: 43114,
    nativeSymbol: 'AVAX',
    nativeDecimals: 18,
    wrappedNative: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',
    usdc: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
    ids: {
      dexscreener: 'avalanche',
      geckoterminal: 'avax',
      coingecko: 'avalanche',
      defillama: 'avax',
    },
    defaultRpcUrl: 'https://api.avax.network/ext/bc/C/rpc',
    fallbackRpcUrls: ['https://avalanche-c-chain-rpc.publicnode.com'],
    rpcEnvVar: 'AVALANCHE_RPC_URL',
    explorerTxUrl: (h) => `https://snowtrace.io/tx/${h}`,
    explorerAddressUrl: (a) => `https://snowtrace.io/address/${a}`,
    spotRouter: 'oneinch',
    blockTimeMs: 2_000,
  },

  optimism: {
    key: 'optimism',
    family: 'EVM',
    displayName: 'Optimism',
    evmChainId: 10,
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    wrappedNative: '0x4200000000000000000000000000000000000006',
    usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    ids: {
      dexscreener: 'optimism',
      geckoterminal: 'optimism',
      coingecko: 'optimistic-ethereum',
      defillama: 'optimism',
    },
    defaultRpcUrl: 'https://mainnet.optimism.io',
    fallbackRpcUrls: ['https://optimism-rpc.publicnode.com', 'https://rpc.ankr.com/optimism'],
    rpcEnvVar: 'OPTIMISM_RPC_URL',
    explorerTxUrl: (h) => `https://optimistic.etherscan.io/tx/${h}`,
    explorerAddressUrl: (a) => `https://optimistic.etherscan.io/address/${a}`,
    spotRouter: 'oneinch',
    blockTimeMs: 2_000,
  },

  blast: {
    key: 'blast',
    family: 'EVM',
    displayName: 'Blast',
    evmChainId: 81457,
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    wrappedNative: '0x4300000000000000000000000000000000000004',
    // Blast has no native-issued USDC; USDB is the canonical stable.
    usdc: '0x4300000000000000000000000000000000000003',
    ids: {
      dexscreener: 'blast',
      geckoterminal: 'blast',
      coingecko: 'blast',
      defillama: 'blast',
    },
    defaultRpcUrl: 'https://rpc.blast.io',
    fallbackRpcUrls: ['https://blast-rpc.publicnode.com'],
    rpcEnvVar: 'BLAST_RPC_URL',
    explorerTxUrl: (h) => `https://blastscan.io/tx/${h}`,
    explorerAddressUrl: (a) => `https://blastscan.io/address/${a}`,
    spotRouter: 'oneinch',
    blockTimeMs: 2_000,
  },
};

export const ALL_CHAINS: ChainSpec[] = Object.values(CHAINS);
export const CHAIN_KEYS = Object.keys(CHAINS) as ChainKey[];

// ── Lookups ──
// Built once at module load so hot paths (the scanner runs every few seconds)
// never pay for a linear scan.

const BY_DEXSCREENER = new Map(ALL_CHAINS.map((c) => [c.ids.dexscreener, c]));
const BY_GECKOTERMINAL = new Map(ALL_CHAINS.map((c) => [c.ids.geckoterminal, c]));
const BY_COINGECKO = new Map(ALL_CHAINS.map((c) => [c.ids.coingecko, c]));
const BY_EVM_ID = new Map(
  ALL_CHAINS.filter((c) => c.evmChainId != null).map((c) => [c.evmChainId!, c]),
);

export function getChain(key: ChainKey): ChainSpec {
  return CHAINS[key];
}

export function isChainKey(v: string): v is ChainKey {
  return v in CHAINS;
}

export function fromDexScreener(chainId: string): ChainSpec | null {
  return BY_DEXSCREENER.get(chainId) ?? null;
}

export function fromGeckoTerminal(slug: string): ChainSpec | null {
  return BY_GECKOTERMINAL.get(slug) ?? null;
}

export function fromCoinGecko(platform: string): ChainSpec | null {
  return BY_COINGECKO.get(platform) ?? null;
}

export function fromEvmChainId(id: number): ChainSpec | null {
  return BY_EVM_ID.get(id) ?? null;
}

/**
 * Resolves a chain from anything a caller might have: our key, a DexScreener
 * chainId, a GeckoTerminal slug, a numeric EVM id, or the legacy Prisma enum.
 *
 * The legacy `'EVM'` value is deliberately mapped to Ethereum: that is what the
 * old `resolveEvmChainId` defaulted to, so existing rows keep their meaning.
 */
export function resolveChain(input: string | number | null | undefined): ChainSpec | null {
  if (input == null) return null;

  if (typeof input === 'number') return fromEvmChainId(input);

  const raw = input.trim();
  if (!raw) return null;

  // Numeric string → EVM chain id
  if (/^\d+$/.test(raw)) return fromEvmChainId(parseInt(raw, 10));

  const lower = raw.toLowerCase();

  if (isChainKey(lower)) return CHAINS[lower];

  // Legacy Prisma Chain enum
  if (lower === 'solana') return CHAINS.solana;
  if (lower === 'evm') return CHAINS.ethereum;

  return (
    BY_DEXSCREENER.get(lower) ??
    BY_GECKOTERMINAL.get(lower) ??
    BY_COINGECKO.get(lower) ??
    null
  );
}

/** Chains we can actually route a spot swap on. */
export function tradableChains(): ChainSpec[] {
  return ALL_CHAINS;
}

/** Resolves the RPC for a chain, honouring the per-chain env override. */
export function rpcUrlFor(chain: ChainSpec): string {
  return process.env[chain.rpcEnvVar] || chain.defaultRpcUrl;
}

/**
 * Bridges the precise chain key back to the coarse Prisma `Chain` enum so this
 * registry can be used in code paths that still persist the old enum.
 */
export function toPrismaChain(chain: ChainSpec): ChainFamily {
  return chain.family;
}

/**
 * Best-effort address-shape detection. Solana mints are base58 and 32-44 chars;
 * EVM addresses are 0x + 40 hex. This narrows candidate chains when the caller
 * gives us a bare address with no chain hint.
 */
export function chainsForAddress(address: string): ChainSpec[] {
  const a = address.trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(a)) {
    return ALL_CHAINS.filter((c) => c.family === 'EVM');
  }
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) {
    return [CHAINS.solana];
  }
  return [];
}
