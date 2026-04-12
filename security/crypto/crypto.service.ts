import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

// ─── Interfaces ─────────────────────────────────────────────────────────────

export interface SecretsLoader {
  get(key: string): string;
}

// ─── Zod Schemas ────────────────────────────────────────────────────────────

export const EncryptedValueSchema = z.object({
  ciphertext: z.string().base64().min(1),
  iv: z.string().base64().min(1),
  authTag: z.string().base64().min(1),
  keyId: z.string().min(1),
});

export type EncryptedValue = z.infer<typeof EncryptedValueSchema>;

const EncryptInputSchema = z.object({
  plaintext: z.string().min(1),
  keyId: z.string().min(1),
});

// ─── Constants ──────────────────────────────────────────────────────────────

const AES_KEY_LENGTH_BYTES = 32;
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;
const AES_ALGORITHM = 'aes-256-gcm' as const;

// ─── Service ────────────────────────────────────────────────────────────────

export class CryptoService {
  private readonly secretsLoader: SecretsLoader;

  constructor(secretsLoader: SecretsLoader) {
    this.secretsLoader = secretsLoader;
  }

  async encrypt(plaintext: string, keyId: string): Promise<EncryptedValue> {
    const parsed = EncryptInputSchema.parse({ plaintext, keyId });

    const keyHex = this.secretsLoader.get(parsed.keyId);
    const keyBuffer = Buffer.from(keyHex, 'hex');

    if (keyBuffer.length !== AES_KEY_LENGTH_BYTES) {
      throw new Error(
        `Encryption key must be ${AES_KEY_LENGTH_BYTES} bytes (${AES_KEY_LENGTH_BYTES * 2} hex chars), got ${keyBuffer.length} bytes`,
      );
    }

    const iv = randomBytes(IV_LENGTH_BYTES);
    const cipher = createCipheriv(AES_ALGORITHM, keyBuffer, iv, {
      authTagLength: AUTH_TAG_LENGTH_BYTES,
    });

    const encrypted = Buffer.concat([
      cipher.update(parsed.plaintext, 'utf8'),
      cipher.final(),
    ]);

    const authTag = cipher.getAuthTag();

    return {
      ciphertext: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      keyId: parsed.keyId,
    };
  }

  async decrypt(encrypted: EncryptedValue): Promise<string> {
    const parsed = EncryptedValueSchema.parse(encrypted);

    const keyHex = this.secretsLoader.get(parsed.keyId);
    const keyBuffer = Buffer.from(keyHex, 'hex');

    if (keyBuffer.length !== AES_KEY_LENGTH_BYTES) {
      throw new Error(
        `Decryption key must be ${AES_KEY_LENGTH_BYTES} bytes (${AES_KEY_LENGTH_BYTES * 2} hex chars), got ${keyBuffer.length} bytes`,
      );
    }

    const iv = Buffer.from(parsed.iv, 'base64');
    const authTag = Buffer.from(parsed.authTag, 'base64');
    const ciphertext = Buffer.from(parsed.ciphertext, 'base64');

    const decipher = createDecipheriv(AES_ALGORITHM, keyBuffer, iv, {
      authTagLength: AUTH_TAG_LENGTH_BYTES,
    });
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  }

  hash(value: string): string {
    z.string().min(1).parse(value);
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }
}
