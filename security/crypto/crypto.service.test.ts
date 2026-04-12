import { describe, it, expect, beforeEach } from 'vitest';
import { CryptoService, type EncryptedValue, type SecretsLoader } from './crypto.service.js';

// ─── Test fixtures ──────────────────────────────────────────────────────────

// 32 bytes = 64 hex chars
const TEST_KEY_HEX = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';
const ALTERNATE_KEY_HEX = '1122334455667788990011223344556677889900112233445566778899001122';

function makeSecretsLoader(keys: Record<string, string>): SecretsLoader {
  return {
    get(key: string): string {
      const value = keys[key];
      if (value === undefined) {
        throw new Error(`Secret not found: ${key}`);
      }
      return value;
    },
  };
}

describe('CryptoService', () => {
  let service: CryptoService;
  let secretsLoader: SecretsLoader;

  beforeEach(() => {
    secretsLoader = makeSecretsLoader({
      'default-key': TEST_KEY_HEX,
      'alt-key': ALTERNATE_KEY_HEX,
    });
    service = new CryptoService(secretsLoader);
  });

  // ── Encrypt / Decrypt round-trip ────────────────────────────────────────

  describe('encrypt and decrypt round-trip', () => {
    it('should decrypt to the original plaintext', async () => {
      const plaintext = 'super secret trading data';
      const encrypted = await service.encrypt(plaintext, 'default-key');
      const decrypted = await service.decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it('should produce different ciphertexts for the same plaintext (random IV)', async () => {
      const plaintext = 'deterministic input';
      const a = await service.encrypt(plaintext, 'default-key');
      const b = await service.encrypt(plaintext, 'default-key');
      expect(a.ciphertext).not.toBe(b.ciphertext);
      expect(a.iv).not.toBe(b.iv);
    });

    it('should handle unicode plaintext', async () => {
      const plaintext = '🔐 emoji & unicode: Ωαβγ 日本語';
      const encrypted = await service.encrypt(plaintext, 'default-key');
      const decrypted = await service.decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it('should populate all EncryptedValue fields', async () => {
      const encrypted = await service.encrypt('test', 'default-key');
      expect(encrypted.ciphertext).toBeTruthy();
      expect(encrypted.iv).toBeTruthy();
      expect(encrypted.authTag).toBeTruthy();
      expect(encrypted.keyId).toBe('default-key');
    });
  });

  // ── Tampered ciphertext ─────────────────────────────────────────────────

  describe('tampered ciphertext', () => {
    it('should throw when ciphertext is tampered', async () => {
      const encrypted = await service.encrypt('sensitive data', 'default-key');

      const ciphertextBuf = Buffer.from(encrypted.ciphertext, 'base64');
      ciphertextBuf[0] = (ciphertextBuf[0]! ^ 0xff) & 0xff;
      const tampered: EncryptedValue = {
        ...encrypted,
        ciphertext: ciphertextBuf.toString('base64'),
      };

      await expect(service.decrypt(tampered)).rejects.toThrow();
    });
  });

  // ── Tampered authTag ────────────────────────────────────────────────────

  describe('tampered authTag', () => {
    it('should throw when authTag is tampered', async () => {
      const encrypted = await service.encrypt('sensitive data', 'default-key');

      const authTagBuf = Buffer.from(encrypted.authTag, 'base64');
      authTagBuf[0] = (authTagBuf[0]! ^ 0xff) & 0xff;
      const tampered: EncryptedValue = {
        ...encrypted,
        authTag: authTagBuf.toString('base64'),
      };

      await expect(service.decrypt(tampered)).rejects.toThrow();
    });
  });

  // ── Wrong key ───────────────────────────────────────────────────────────

  describe('wrong key', () => {
    it('should throw when decrypting with a different key', async () => {
      const encrypted = await service.encrypt('confidential', 'default-key');

      const wrongKeyEncrypted: EncryptedValue = {
        ...encrypted,
        keyId: 'alt-key',
      };

      await expect(service.decrypt(wrongKeyEncrypted)).rejects.toThrow();
    });
  });

  // ── Input validation ────────────────────────────────────────────────────

  describe('input validation', () => {
    it('should throw for empty plaintext', async () => {
      await expect(service.encrypt('', 'default-key')).rejects.toThrow();
    });

    it('should throw for empty keyId', async () => {
      await expect(service.encrypt('data', '')).rejects.toThrow();
    });
  });

  // ── Hash ────────────────────────────────────────────────────────────────

  describe('hash', () => {
    it('should produce deterministic output', () => {
      const a = service.hash('user@example.com');
      const b = service.hash('user@example.com');
      expect(a).toBe(b);
    });

    it('should produce different hashes for different inputs', () => {
      const a = service.hash('alice');
      const b = service.hash('bob');
      expect(a).not.toBe(b);
    });

    it('should return a 64-char hex string (SHA-256)', () => {
      const h = service.hash('test-value');
      expect(h).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should not be reversible (hash differs from input)', () => {
      const input = 'plaintext-identifier';
      const h = service.hash(input);
      expect(h).not.toBe(input);
      expect(h.length).toBe(64);
    });

    it('should throw for empty value', () => {
      expect(() => service.hash('')).toThrow();
    });
  });
});
