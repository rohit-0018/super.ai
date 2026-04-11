import { Injectable, Logger } from '@nestjs/common';
import { KMSClient, GenerateDataKeyCommand, DecryptCommand } from '@aws-sdk/client-kms';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';

export interface EnvelopeCiphertext {
  ciphertext: string; // base64
  encryptedDek: string; // base64
}

/**
 * AWS KMS envelope encryption with AES-256-GCM data key.
 * Falls back to a deterministic local key derived from JWT_SECRET when AWS_KMS_KEY_ID is unset
 * (development only — never enable in production).
 */
@Injectable()
export class KmsService {
  private readonly logger = new Logger(KmsService.name);
  private kms = process.env.AWS_KMS_KEY_ID
    ? new KMSClient({ region: process.env.AWS_REGION ?? 'us-east-1' })
    : null;

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
    this.logger.warn('Using local KMS fallback — DEV ONLY');
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
