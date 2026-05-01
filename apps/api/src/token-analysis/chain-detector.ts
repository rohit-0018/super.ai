import type { Chain } from './token-analysis.types';

const SOLANA_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_RE    = /^0x[a-fA-F0-9]{40}$/;

/**
 * Auto-detect chain from address format.
 * Returns null when the address doesn't match any known format.
 */
export function detectChain(address: string): Chain | null {
  const a = address.trim();
  if (SOLANA_RE.test(a)) return 'SOLANA';
  if (EVM_RE.test(a))    return 'EVM';
  return null;
}

export function validateAddress(chain: Chain, address: string): boolean {
  if (chain === 'SOLANA') return SOLANA_RE.test(address.trim());
  if (chain === 'EVM')    return EVM_RE.test(address.trim());
  return false;
}
