/**
 * Single source of truth for network mode (testnet vs mainnet).
 * Every service reads RPC URLs, chain IDs, and API bases from here.
 * Controlled by NETWORK_MODE env var.
 */

export type NetworkMode = 'testnet' | 'mainnet';

export function getNetworkMode(): NetworkMode {
  const mode = (process.env.NETWORK_MODE ?? 'mainnet').toLowerCase();
  return mode === 'testnet' ? 'testnet' : 'mainnet';
}

export function isTestnet(): boolean {
  return getNetworkMode() === 'testnet';
}

// ── Solana ──

export function getSolanaRpcUrl(): string {
  if (isTestnet()) {
    return process.env.SOLANA_TESTNET_RPC_URL ?? 'https://api.devnet.solana.com';
  }
  return process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
}

export function getJupiterApiBase(): string {
  if (isTestnet()) {
    // Jupiter has no official devnet API — we'll mock swaps in testnet mode
    return 'MOCK';
  }
  return process.env.JUPITER_API_BASE ?? 'https://quote-api.jup.ag/v6';
}

// ── EVM ──

const MAINNET_CHAIN_IDS: Record<string, number> = {
  ETH: 1,
  ARBITRUM: 42161,
  BASE: 8453,
};

const TESTNET_CHAIN_IDS: Record<string, number> = {
  ETH: 11155111,       // Sepolia
  ARBITRUM: 421614,     // Arbitrum Sepolia
  BASE: 84532,          // Base Sepolia
};

export function getEvmChainId(chain: string): number {
  const map = isTestnet() ? TESTNET_CHAIN_IDS : MAINNET_CHAIN_IDS;
  return map[chain.toUpperCase()] ?? map.ETH;
}

export function getEvmRpcUrl(chain?: string): string {
  if (isTestnet()) {
    return process.env.EVM_TESTNET_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com';
  }
  return process.env.EVM_RPC_URL ?? 'https://eth.llamarpc.com';
}

export function getOneInchApiBase(): string {
  if (isTestnet()) {
    // 1inch doesn't support testnets — we'll mock
    return 'MOCK';
  }
  return 'https://api.1inch.dev/swap/v6.0';
}

// ── Summary ──

export function getNetworkConfig() {
  const mode = getNetworkMode();
  return {
    mode,
    isTestnet: mode === 'testnet',
    solana: {
      rpcUrl: getSolanaRpcUrl(),
      jupiterBase: getJupiterApiBase(),
      network: mode === 'testnet' ? 'devnet' : 'mainnet-beta',
    },
    evm: {
      rpcUrl: getEvmRpcUrl(),
      chainIds: mode === 'testnet' ? TESTNET_CHAIN_IDS : MAINNET_CHAIN_IDS,
      oneInchBase: getOneInchApiBase(),
    },
  };
}
