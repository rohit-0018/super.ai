// Regex-based CA extraction. Stateless utility — no I/O, sub-millisecond.

// Base58 alphabet excludes 0, O, I, l
const SOL_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const EVM_RE = /\b0x[a-fA-F0-9]{40}\b/gi;

// Well-known stable/wrapped tokens to skip on Solana — we don't snipe these
const SOL_SKIP = new Set([
  'So11111111111111111111111111111111111111112',    // wSOL (native)
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', // WETH (Wormhole)
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', // WBTC (Wormhole)
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',  // mSOL (Marinade)
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
]);

const EVM_SKIP = new Set([
  '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', // WBTC
]);

export function extractSolanaAddresses(text: string): string[] {
  const matches = [...text.matchAll(new RegExp(SOL_RE.source, 'g'))].map((m) => m[0]);
  return [...new Set(matches)].filter((a) => !SOL_SKIP.has(a));
}

export function extractEvmAddresses(text: string): string[] {
  const matches = [...text.matchAll(new RegExp(EVM_RE.source, 'gi'))].map((m) => m[0].toLowerCase());
  return [...new Set(matches)].filter((a) => !EVM_SKIP.has(a));
}

export function extractAddresses(text: string, chain: 'SOLANA' | 'EVM'): string[] {
  return chain === 'SOLANA' ? extractSolanaAddresses(text) : extractEvmAddresses(text);
}

// Heuristic: if message contains an EVM address prefer EVM; else Solana
export function detectChainHint(text: string): 'SOLANA' | 'EVM' {
  return EVM_RE.test(text) ? 'EVM' : 'SOLANA';
}

/**
 * Check whether a message matches a user-defined pattern.
 * Pattern is treated as a regex; falls back to substring search if invalid.
 * Returns true when no pattern is set (default = match everything).
 */
export function matchesPattern(text: string, pattern: string | null | undefined): boolean {
  if (!pattern) return true;
  try {
    return new RegExp(pattern, 'i').test(text);
  } catch {
    return text.toLowerCase().includes(pattern.toLowerCase());
  }
}
