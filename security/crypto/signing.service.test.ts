import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { SigningService, type SecretsLoader } from './signing.service.js';

// ─── Test fixtures ──────────────────────────────────────────────────────────

let privatePem: string;
let publicPem: string;
let altPrivatePem: string;
let altPublicPem: string;

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

beforeAll(() => {
  const primary = generateKeyPairSync('ed25519');
  privatePem = primary.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  publicPem = primary.publicKey.export({ type: 'spki', format: 'pem' }) as string;

  const alt = generateKeyPairSync('ed25519');
  altPrivatePem = alt.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  altPublicPem = alt.publicKey.export({ type: 'spki', format: 'pem' }) as string;
});

describe('SigningService', () => {
  // ── Sign / Verify round-trip ──────────────────────────────────────────

  describe('sign and verify round-trip', () => {
    it('should verify a payload signed with the matching keypair', async () => {
      const loader = makeSecretsLoader({ 'signing-private-key': privatePem });
      const service = new SigningService(loader);

      const payload = { action: 'buy', instrument: 'BTC-USD', amount: 1.5 };
      const signature = await service.sign(payload);
      const valid = await service.verify(payload, signature, publicPem);

      expect(valid).toBe(true);
    });

    it('should produce a base64 signature string', async () => {
      const loader = makeSecretsLoader({ 'signing-private-key': privatePem });
      const service = new SigningService(loader);

      const signature = await service.sign({ test: true });
      // Base64 chars: A-Z a-z 0-9 + / =
      expect(signature).toMatch(/^[A-Za-z0-9+/]+=*$/);
    });
  });

  // ── Tampered payload ──────────────────────────────────────────────────

  describe('tampered payload', () => {
    it('should fail verification when payload is modified', async () => {
      const loader = makeSecretsLoader({ 'signing-private-key': privatePem });
      const service = new SigningService(loader);

      const payload = { action: 'buy', instrument: 'BTC-USD', amount: 1.5 };
      const signature = await service.sign(payload);

      const tampered = { ...payload, amount: 999 };
      const valid = await service.verify(tampered, signature, publicPem);

      expect(valid).toBe(false);
    });

    it('should fail verification when a field is added', async () => {
      const loader = makeSecretsLoader({ 'signing-private-key': privatePem });
      const service = new SigningService(loader);

      const payload = { action: 'sell' };
      const signature = await service.sign(payload);

      const tampered = { action: 'sell', extra: 'field' };
      const valid = await service.verify(tampered, signature, publicPem);

      expect(valid).toBe(false);
    });
  });

  // ── Wrong key ─────────────────────────────────────────────────────────

  describe('wrong key', () => {
    it('should fail verification with a different public key', async () => {
      const loader = makeSecretsLoader({ 'signing-private-key': privatePem });
      const service = new SigningService(loader);

      const payload = { data: 'important' };
      const signature = await service.sign(payload);

      const valid = await service.verify(payload, signature, altPublicPem);
      expect(valid).toBe(false);
    });

    it('should produce different signatures with different private keys', async () => {
      const loader1 = makeSecretsLoader({ 'signing-private-key': privatePem });
      const loader2 = makeSecretsLoader({ 'signing-private-key': altPrivatePem });
      const service1 = new SigningService(loader1);
      const service2 = new SigningService(loader2);

      const payload = { same: 'payload' };
      const sig1 = await service1.sign(payload);
      const sig2 = await service2.sign(payload);

      expect(sig1).not.toBe(sig2);
    });
  });

  // ── Canonical serialization ───────────────────────────────────────────

  describe('canonical serialization', () => {
    it('should produce the same signature regardless of key insertion order', async () => {
      const loader = makeSecretsLoader({ 'signing-private-key': privatePem });
      const service = new SigningService(loader);

      const payloadA = { z: 1, a: 2, m: 3 };
      const payloadB = { a: 2, m: 3, z: 1 };

      const sigA = await service.sign(payloadA);
      const sigB = await service.sign(payloadB);

      expect(sigA).toBe(sigB);
    });

    it('should produce different signatures for semantically different payloads with same keys', async () => {
      const loader = makeSecretsLoader({ 'signing-private-key': privatePem });
      const service = new SigningService(loader);

      const payloadA = { x: 1 };
      const payloadB = { x: 2 };

      const sigA = await service.sign(payloadA);
      const sigB = await service.sign(payloadB);

      expect(sigA).not.toBe(sigB);
    });

    it('should canonicalize nested objects by sorting keys recursively', async () => {
      const loader = makeSecretsLoader({ 'signing-private-key': privatePem });
      const service = new SigningService(loader);

      const payloadA = { outer: { z: 1, a: 2 } };
      const payloadB = { outer: { a: 2, z: 1 } };

      const sigA = await service.sign(payloadA);
      const sigB = await service.sign(payloadB);

      expect(sigA).toBe(sigB);

      const valid = await service.verify(payloadB, sigA, publicPem);
      expect(valid).toBe(true);
    });
  });
});
