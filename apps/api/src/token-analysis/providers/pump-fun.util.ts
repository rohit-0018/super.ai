/**
 * pump.fun mints are minted by the platform with the literal suffix "pump" —
 * a stable on-chain fingerprint that lets us identify bonding-curve tokens
 * without any external lookup. Used to:
 *   - skip Jupiter / Raydium-route APIs that 404 on pre-graduation tokens,
 *   - gate calls to PumpFunProvider (the direct-from-pump.fun fetch),
 *   - flag tokens for pump.fun-specific scoring rules and lore framing.
 */
export function isPumpFunMint(mint: string): boolean {
  return typeof mint === 'string' && mint.length > 4 && mint.toLowerCase().endsWith('pump');
}
