import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { UndiciHttpService } from './undici-http.service';

@Injectable()
export class JitoClient {
  private readonly logger = new Logger(JitoClient.name);
  private readonly enabled: boolean;
  private readonly url: string;
  private readonly tipLamports: number;
  private readonly tipAccounts: PublicKey[];

  constructor(
    private config: ConfigService,
    private http: UndiciHttpService,
  ) {
    this.enabled = config.get<string>('FAST_LANE_USE_JITO', 'false') === 'true';
    this.url = config.get<string>(
      'FAST_LANE_JITO_URL',
      'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
    );
    this.tipLamports = parseInt(
      config.get<string>('FAST_LANE_JITO_TIP_LAMPORTS', '1000000'),
      10,
    );

    const tipAccountsRaw = config.get<string>(
      'FAST_LANE_JITO_TIP_ACCOUNTS',
      '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5,HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
    );
    const tipAccountStrs = tipAccountsRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    let parsed: PublicKey[] = [];
    try {
      parsed = tipAccountStrs.map((s) => new PublicKey(s));
    } catch (e) {
      this.logger.warn(
        `Invalid Jito tip account config, using empty list: ${(e as Error).message}`,
      );
      parsed = [];
    }
    this.tipAccounts = parsed;
  }

  isEnabled(): boolean {
    return this.enabled && this.tipAccounts.length > 0;
  }

  /** Pick a random tip account to spread load across validators */
  pickRandomTipAccount(): PublicKey {
    if (this.tipAccounts.length === 0) {
      throw new Error('No Jito tip accounts configured');
    }
    const idx = Math.floor(Math.random() * this.tipAccounts.length);
    return this.tipAccounts[idx]!;
  }

  getTipLamports(): number {
    return this.tipLamports;
  }

  /** Build a tip-transfer instruction to include in the bundle */
  buildTipInstruction(fromPubkey: PublicKey): TransactionInstruction {
    return SystemProgram.transfer({
      fromPubkey,
      toPubkey: this.pickRandomTipAccount(),
      lamports: this.tipLamports,
    });
  }

  /**
   * Submit a bundle of signed transactions. Each tx must be a base64-encoded
   * wire-format transaction. Returns the bundle ID.
   * One of the txs must include a tip transfer to a Jito tip account.
   */
  async sendBundle(signedTxsBase64: string[]): Promise<string> {
    if (!this.isEnabled()) {
      throw new Error('Jito not enabled (set FAST_LANE_USE_JITO=true)');
    }
    if (signedTxsBase64.length === 0 || signedTxsBase64.length > 5) {
      throw new Error('Bundle must contain 1-5 transactions');
    }

    // Parse origin + path from url
    const parsed = new URL(this.url);
    const origin = `${parsed.protocol}//${parsed.host}`;
    const path = parsed.pathname + parsed.search;

    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'sendBundle',
      params: [signedTxsBase64],
    });

    const start = Date.now();
    try {
      const response = await this.http.request<{
        jsonrpc: string;
        result?: string;
        error?: { code: number; message: string };
        id: number;
      }>(origin, { path, method: 'POST', body: payload, timeoutMs: 5000 });
      if (response.body.error) {
        throw new Error(
          `Jito error ${response.body.error.code}: ${response.body.error.message}`,
        );
      }
      if (!response.body.result) {
        throw new Error(
          `Jito returned no result: ${JSON.stringify(response.body)}`,
        );
      }
      const elapsed = Date.now() - start;
      this.logger.log(
        `Jito bundle submitted: bundleId=${response.body.result} elapsed=${elapsed}ms txCount=${signedTxsBase64.length}`,
      );
      return response.body.result;
    } catch (err: any) {
      const elapsed = Date.now() - start;
      this.logger.error(
        `Jito bundle submission failed after ${elapsed}ms: ${err.message}`,
      );
      throw err;
    }
  }
}
