/**
 * Curated list of known consistently profitable Solana wallets.
 * Add addresses of alpha wallets, whale traders, and known smart money here.
 * Sources: Birdeye leaderboard top traders, on-chain analysis of early successful entries.
 *
 * Keep to ≤ 30 wallets on free tier (Helius 10 RPS — ~3s to check all).
 */
export interface SmartWallet {
  address: string;
  label: string;
}

export const SMART_MONEY_WALLETS: SmartWallet[] = [
  // Add known alpha wallets here as you identify them from on-chain research.
  // Example format:
  // { address: 'SOLANA_WALLET_ADDRESS', label: 'alpha_whale_1' },
];
