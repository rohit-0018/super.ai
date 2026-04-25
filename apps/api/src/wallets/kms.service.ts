import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { KMSClient, GenerateDataKeyCommand, DecryptCommand } from '@aws-sdk/client-kms';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';
import { getNetworkMode, isTestnet } from '../common/network-config';

export interface EnvelopeCiphertext {
  ciphertext: string; // base64
  encryptedDek: string; // base64
}

/**
 * AWS KMS envelope encryption with AES-256-GCM data key.
 *
 * Production (mainnet): AWS_KMS_KEY_ID MUST be set. Boot fails otherwise.
 * Dev/testnet: falls back to a deterministic key from JWT_SECRET if no KMS key
 * configured. This fallback is NEVER allowed on mainnet because a leaked
 * JWT_SECRET would decrypt every wallet.
 */
@Injectable()
export class KmsService implements OnModuleInit {
  private readonly logger = new Logger(KmsService.name);
  private kms = process.env.AWS_KMS_KEY_ID
    ? new KMSClient({ region: process.env.AWS_REGION ?? 'us-east-1' })
    : null;

  onModuleInit() {
    const mode = getNetworkMode();
    const unsafeOptIn = process.env.ALLOW_UNSAFE_LOCAL_KMS === '1';

    if (mode === 'mainnet' && !this.kms && !unsafeOptIn) {
      const msg =
        '[KMS] FATAL: NETWORK_MODE=mainnet but AWS_KMS_KEY_ID is not set. ' +
        'Refusing to boot — local key fallback would decrypt real wallets with a leaked JWT_SECRET. ' +
        'For solo-dev mainnet testing with throwaway wallets, set ALLOW_UNSAFE_LOCAL_KMS=1.';
      this.logger.error(msg);
      throw new Error(msg);
    }

    if (mode === 'mainnet' && !this.kms && unsafeOptIn) {
      // Loud, ugly, repeated warnings so this is impossible to miss in logs.
      const warn = () => this.logger.warn(
        '╔══════════════════════════════════════════════════════════════════════╗\n' +
        '║ [KMS] UNSAFE: mainnet + local JWT_SECRET fallback. ALLOW_UNSAFE_LOCAL_KMS=1.  ║\n' +
        '║ Anyone who learns JWT_SECRET can decrypt every wallet on this server.        ║\n' +
        '║ NEVER set this flag in production. Throwaway/test wallets only.              ║\n' +
        '╚══════════════════════════════════════════════════════════════════════╝',
      );
      warn();
      // Repeat every 5 minutes so it stays visible across long sessions.
      setInterval(warn, 5 * 60_000).unref?.();
      return;
    }

    if (!this.kms) {
      this.logger.warn(
        `[KMS] Using local JWT_SECRET fallback — DEV/TESTNET ONLY. NETWORK_MODE=${mode}`,
      );
    } else {
      this.logger.log(
        `[KMS] Using AWS KMS (${process.env.AWS_REGION ?? 'us-east-1'}) — mainnet-safe. NETWORK_MODE=${mode}`,
      );
    }
  }

  async encrypt(plaintext: Buffer): Promise<EnvelopeCiphertext> {
    const { dataKey, encryptedDek } = await this.generateDataKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
    const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      ciphertext: Buffer.concat([iv, tag, enc]).toString('base64'),
      encryptedDek,
    };
  }

  async decrypt(envelope: EnvelopeCiphertext): Promise<Buffer> {
    const dataKey = await this.unwrapDataKey(envelope.encryptedDek);
    const buf = Buffer.from(envelope.ciphertext, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', dataKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]);
  }

  private async generateDataKey(): Promise<{ dataKey: Buffer; encryptedDek: string }> {
    if (this.kms) {
      const out = await this.kms.send(
        new GenerateDataKeyCommand({ KeyId: process.env.AWS_KMS_KEY_ID, KeySpec: 'AES_256' }),
      );
      return {
        dataKey: Buffer.from(out.Plaintext as Uint8Array),
        encryptedDek: Buffer.from(out.CiphertextBlob as Uint8Array).toString('base64'),
      };
    }
    // Safety net — onModuleInit has already either thrown OR opted in via
    // ALLOW_UNSAFE_LOCAL_KMS. We only refuse here if the flag is missing.
    if (!isTestnet() && process.env.ALLOW_UNSAFE_LOCAL_KMS !== '1') {
      throw new Error('[KMS] Refused to generate data key: mainnet without AWS_KMS_KEY_ID');
    }
    const dataKey = randomBytes(32);
    const wrapped = this.localWrap(dataKey);
    return { dataKey, encryptedDek: wrapped };
  }

  private async unwrapDataKey(encryptedDek: string): Promise<Buffer> {
    if (this.kms) {
      const out = await this.kms.send(
        new DecryptCommand({ CiphertextBlob: Buffer.from(encryptedDek, 'base64') }),
      );
      return Buffer.from(out.Plaintext as Uint8Array);
    }
    return this.localUnwrap(encryptedDek);
  }

  private masterKey(): Buffer {
    return createHash('sha256').update(process.env.JWT_SECRET ?? 'dev').digest();
  }

  private localWrap(key: Buffer): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.masterKey(), iv);
    const enc = Buffer.concat([c.update(key), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
  }

  private localUnwrap(b64: string): Buffer {
    const buf = Buffer.from(b64, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const d = createDecipheriv('aes-256-gcm', this.masterKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]);
  }
}
