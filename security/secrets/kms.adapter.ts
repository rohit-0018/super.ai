import { z } from 'zod';
import { KMSClient, DecryptCommand, DescribeKeyCommand } from '@aws-sdk/client-kms';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface KeyVersion {
  versionId: string;
  createdAt: string;
  status: string;
}

export interface KmsAdapter {
  getSecret(keyId: string): Promise<string>;
  listKeyVersions(keyId: string): Promise<KeyVersion[]>;
}

// ─── Zod schemas for untyped SDK boundaries ─────────────────────────────────

const DecryptResponseSchema = z.object({
  Plaintext: z.instanceof(Uint8Array),
});

const ListKeyVersionsResponseSchema = z.object({
  KeyMetadata: z.object({
    KeyId: z.string(),
    CreationDate: z.date().optional(),
    KeyState: z.string().optional(),
  }).optional(),
});

// ─── AwsKmsAdapter ──────────────────────────────────────────────────────────

export class AwsKmsAdapter implements KmsAdapter {
  private readonly client: KMSClient;
  private readonly keyArn: string;

  constructor(client: KMSClient, keyArn: string) {
    this.client = client;
    this.keyArn = keyArn;
  }

  public async getSecret(keyId: string): Promise<string> {
    const envValue = process.env[keyId];
    if (envValue === undefined || envValue === '') {
      throw new Error(`Environment variable ${keyId} is not set`);
    }

    const ciphertextBlob = Buffer.from(envValue, 'base64');

    const command = new DecryptCommand({
      CiphertextBlob: ciphertextBlob,
      KeyId: this.keyArn,
    });

    // AWS SDK returns untyped response; validate with Zod
    const rawResponse: unknown = await this.client.send(command);
    const response = DecryptResponseSchema.parse(rawResponse);

    const decoder = new TextDecoder('utf-8');
    return decoder.decode(response.Plaintext);
  }

  public async listKeyVersions(keyId: string): Promise<KeyVersion[]> {
    // AWS KMS DescribeKey returns metadata about the key.
    // For rotation tracking, we use DescribeKey for a single-version representation.
    const command = new DescribeKeyCommand({ KeyId: keyId });

    // AWS SDK returns untyped response; validate with Zod
    const rawResponse: unknown = await this.client.send(command);
    const parsed = ListKeyVersionsResponseSchema.parse(rawResponse);

    if (!parsed.KeyMetadata) {
      return [];
    }

    const metadata = parsed.KeyMetadata;
    return [
      {
        versionId: metadata.KeyId,
        createdAt: metadata.CreationDate?.toISOString() ?? new Date().toISOString(),
        status: metadata.KeyState ?? 'Enabled',
      },
    ];
  }
}

// ─── LocalKmsAdapter ────────────────────────────────────────────────────────

export class LocalKmsAdapter implements KmsAdapter {
  public async getSecret(keyId: string): Promise<string> {
    const value = process.env[keyId];
    if (value === undefined || value === '') {
      throw new Error(`Environment variable ${keyId} is not set`);
    }
    return value;
  }

  public async listKeyVersions(keyId: string): Promise<KeyVersion[]> {
    const value = process.env[keyId];
    if (value === undefined || value === '') {
      return [];
    }
    return [
      {
        versionId: 'local-v1',
        createdAt: new Date().toISOString(),
        status: 'Active',
      },
    ];
  }
}
