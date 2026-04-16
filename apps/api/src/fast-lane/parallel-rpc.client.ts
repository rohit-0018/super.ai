import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Connection, SendOptions } from '@solana/web3.js';

export interface ParallelSendResult {
  signature: string;
  winningRpc: string;
  elapsedMs: number;
  attemptCount: number;
}

@Injectable()
export class ParallelRpcClient {
  private readonly logger = new Logger(ParallelRpcClient.name);
  private readonly enabled: boolean;
  private readonly connections: Array<{ url: string; conn: Connection }>;

  constructor(private config: ConfigService) {
    this.enabled =
      config.get<string>('FAST_LANE_USE_PARALLEL_RPC', 'true') === 'true';
    const rpcsRaw = config.get<string>(
      'FAST_LANE_SOLANA_RPCS',
      'https://api.mainnet-beta.solana.com',
    );
    const urls = rpcsRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    this.connections = urls.map((url) => ({
      url,
      conn: new Connection(url, 'confirmed'),
    }));
    this.logger.log(
      `ParallelRpcClient initialized with ${this.connections.length} RPCs: ${urls.join(', ')}`,
    );
  }

  isEnabled(): boolean {
    return this.enabled && this.connections.length > 1;
  }

  getConnections(): Array<{ url: string; conn: Connection }> {
    return this.connections;
  }

  /** Primary connection (first in list) for operations that need a single consistent RPC */
  primaryConnection(): Connection {
    if (this.connections.length === 0) {
      throw new Error('No Solana RPCs configured');
    }
    return this.connections[0]!.conn;
  }

  /**
   * Send the same signed tx to all configured RPCs in parallel.
   * Returns the signature from whichever RPC responds first successfully.
   * Uses Promise.any so one slow/failing RPC doesn't block the others.
   */
  async sendParallel(
    signedTxWire: Uint8Array,
    options: SendOptions = {},
  ): Promise<ParallelSendResult> {
    if (this.connections.length === 0) {
      throw new Error('No Solana RPCs configured');
    }

    const start = Date.now();
    const opts: SendOptions = {
      skipPreflight: true,
      maxRetries: 0,
      preflightCommitment: 'processed',
      ...options,
    };

    // If only one RPC, don't bother with Promise.any
    if (this.connections.length === 1) {
      const only = this.connections[0]!;
      const sig = await only.conn.sendRawTransaction(signedTxWire, opts);
      return {
        signature: sig,
        winningRpc: only.url,
        elapsedMs: Date.now() - start,
        attemptCount: 1,
      };
    }

    // Fan out to all RPCs
    const promises = this.connections.map(async ({ url, conn }) => {
      const sig = await conn.sendRawTransaction(signedTxWire, opts);
      return { signature: sig, url };
    });

    try {
      const winner = await Promise.any(promises);
      return {
        signature: winner.signature,
        winningRpc: winner.url,
        elapsedMs: Date.now() - start,
        attemptCount: this.connections.length,
      };
    } catch (err: any) {
      // All RPCs failed — err is AggregateError
      const errors =
        err.errors?.map((e: Error) => e.message).join('; ') ?? err.message;
      throw new Error(
        `All ${this.connections.length} RPCs failed: ${errors}`,
      );
    }
  }

  /**
   * Confirm a signature on any available RPC. Used by fire-and-forget async path.
   */
  async confirmSignature(
    signature: string,
    timeoutMs: number = 30000,
  ): Promise<boolean> {
    const start = Date.now();
    const promises = this.connections.map(async ({ conn }) => {
      // Poll status until confirmed or timeout
      while (Date.now() - start < timeoutMs) {
        const status = await conn.getSignatureStatus(signature, {
          searchTransactionHistory: false,
        });
        if (
          status.value?.confirmationStatus === 'confirmed' ||
          status.value?.confirmationStatus === 'finalized'
        ) {
          return true;
        }
        if (status.value?.err) {
          throw new Error(
            `Transaction failed: ${JSON.stringify(status.value.err)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      return false;
    });

    try {
      return await Promise.any(promises);
    } catch {
      return false;
    }
  }
}
