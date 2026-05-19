import { Injectable, Logger } from '@nestjs/common';

/**
 * Jito Block Engine client for MEV-protected bundle submission on Solana.
 *
 * Jito validators see the tip and atomically land the bundle — preventing
 * sandwich attacks. We use Jupiter's swap tx (already built) and submit it
 * directly to the block engine rather than the normal Solana RPC.
 *
 * Docs: https://jito-labs.gitbook.io/mev/searcher-resources/json-rpc-api-reference/bundles
 */

/** Jito tip accounts (mainnet). Pick a random one per bundle to spread load. */
const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1uw5mSZLSxB',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

const JITO_BLOCK_ENGINE_URL =
  process.env.JITO_BLOCK_ENGINE_URL ??
  'https://mainnet.block-engine.jito.labs.io/api/v1/bundles';

/** Default tip: 100_000 lamports = ~0.0001 SOL ≈ $0.015 at $150/SOL. */
export const JITO_TIP_LAMPORTS_DEFAULT = 100_000;
/** ULTRA mode: 500_000 lamports ≈ $0.075 — use for snipes and fast-path. */
export const JITO_TIP_LAMPORTS_ULTRA = 500_000;

export type JitoTipMode = 'auto' | 'ultra';

export interface JitoSubmitResult {
  bundleId: string;
  /** Whether Jito accepted the bundle. False means we should fallback to normal RPC. */
  accepted: boolean;
}

@Injectable()
export class JitoClient {
  private readonly logger = new Logger(JitoClient.name);

  randomTipAccount(): string {
    return JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
  }

  tipLamports(mode: JitoTipMode = 'auto'): number {
    const envOverride = parseInt(process.env.JITO_TIP_LAMPORTS ?? '', 10);
    if (!isNaN(envOverride) && envOverride > 0) return envOverride;
    return mode === 'ultra' ? JITO_TIP_LAMPORTS_ULTRA : JITO_TIP_LAMPORTS_DEFAULT;
  }

  /**
   * Submit a signed Solana transaction to the Jito block engine as a 1-tx bundle.
   *
   * The transaction must already have the tip instruction embedded (added by
   * `buildTipInstruction` before signing). We submit it as a bundle so Jito
   * validators land it atomically with MEV protection.
   *
   * Returns the bundle ID on success. On failure (network error, Jito down,
   * rate limit), returns `accepted: false` — caller should fallback to normal RPC.
   */
  async submitBundle(signedTxBase64: string, traceId?: string): Promise<JitoSubmitResult> {
    const tag = traceId ? `[trc=${traceId}]` : '';
    try {
      const resp = await fetch(JITO_BLOCK_ENGINE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'sendBundle',
          params: [[signedTxBase64]],
        }),
        signal: AbortSignal.timeout(5_000),
      });

      if (!resp.ok) {
        this.logger.warn(`${tag} Jito block engine HTTP ${resp.status} — will fallback`);
        return { bundleId: '', accepted: false };
      }

      const body = (await resp.json()) as any;
      if (body?.error) {
        this.logger.warn(`${tag} Jito error: ${JSON.stringify(body.error)} — will fallback`);
        return { bundleId: '', accepted: false };
      }

      const bundleId: string = body?.result ?? '';
      this.logger.log(`${tag} Jito bundle submitted: ${bundleId}`);
      return { bundleId, accepted: true };
    } catch (e: any) {
      this.logger.warn(`${tag} Jito submission failed: ${e?.message} — will fallback`);
      return { bundleId: '', accepted: false };
    }
  }

  /**
   * Poll Jito bundle status until confirmed or timeout.
   * Returns true if the bundle landed (at least one tx confirmed).
   */
  async waitForBundle(bundleId: string, timeoutMs = 20_000, traceId?: string): Promise<boolean> {
    const tag = traceId ? `[trc=${traceId}]` : '';
    const deadline = Date.now() + timeoutMs;
    const pollIntervalMs = 2_000;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      try {
        const resp = await fetch(JITO_BLOCK_ENGINE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getBundleStatuses',
            params: [[bundleId]],
          }),
          signal: AbortSignal.timeout(4_000),
        });
        if (!resp.ok) continue;
        const body = (await resp.json()) as any;
        const statuses: any[] = body?.result?.value ?? [];
        const status = statuses.find((s: any) => s?.bundle_id === bundleId);
        if (!status) continue;

        const confirmation = status.confirmation_status;
        if (confirmation === 'confirmed' || confirmation === 'finalized') {
          this.logger.log(`${tag} Jito bundle ${bundleId} ${confirmation}`);
          return true;
        }
        if (confirmation === 'failed') {
          this.logger.warn(`${tag} Jito bundle ${bundleId} failed`);
          return false;
        }
      } catch {
        // poll errors are transient — keep trying until deadline
      }
    }

    this.logger.warn(`${tag} Jito bundle ${bundleId} confirmation timed out after ${timeoutMs}ms`);
    return false;
  }
}
