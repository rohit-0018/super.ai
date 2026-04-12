import { sign as ed25519Sign, verify as ed25519Verify, createPrivateKey, createPublicKey } from 'node:crypto';
import { z } from 'zod';

// ─── Interfaces ─────────────────────────────────────────────────────────────

export interface SecretsLoader {
  get(key: string): string;
}

// ─── Zod Schemas ────────────────────────────────────────────────────────────

const PayloadSchema = z.record(z.string(), z.unknown());
const SignatureSchema = z.string().base64().min(1);
const PublicKeyPemSchema = z.string().min(1);

// ─── Helpers ────────────────────────────────────────────────────────────────

function canonicalize(obj: Record<string, unknown>): string {
  return JSON.stringify(sortKeysDeep(obj));
}

function sortKeysDeep(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }

  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(value as Record<string, unknown>).sort();
  for (const key of keys) {
    sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

// ─── Service ────────────────────────────────────────────────────────────────

export class SigningService {
  private readonly secretsLoader: SecretsLoader;

  constructor(secretsLoader: SecretsLoader) {
    this.secretsLoader = secretsLoader;
  }

  async sign(payload: Record<string, unknown>): Promise<string> {
    const validated = PayloadSchema.parse(payload);
    const canonical = canonicalize(validated);
    const data = Buffer.from(canonical, 'utf8');

    const privatePem = this.secretsLoader.get('signing-private-key');
    const privateKey = createPrivateKey(privatePem);

    const signature = ed25519Sign(null, data, privateKey);
    return signature.toString('base64');
  }

  async verify(
    payload: Record<string, unknown>,
    signature: string,
    publicKey: string,
  ): Promise<boolean> {
    const validated = PayloadSchema.parse(payload);
    SignatureSchema.parse(signature);
    PublicKeyPemSchema.parse(publicKey);

    const canonical = canonicalize(validated);
    const data = Buffer.from(canonical, 'utf8');
    const sigBuffer = Buffer.from(signature, 'base64');

    const pubKey = createPublicKey(publicKey);

    return ed25519Verify(null, data, pubKey, sigBuffer);
  }
}
