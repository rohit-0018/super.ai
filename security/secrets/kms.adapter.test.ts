import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AwsKmsAdapter, LocalKmsAdapter } from './kms.adapter.js';
import type { KmsAdapter } from './kms.adapter.js';

// ─── AwsKmsAdapter ──────────────────────────────────────────────────────────

describe('AwsKmsAdapter', () => {
  const keyArn = 'arn:aws:kms:us-east-1:123456789:key/test-key';
  let mockSend: ReturnType<typeof vi.fn>;
  let adapter: KmsAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend = vi.fn();

    // Create a mock KMSClient-like object that satisfies the constructor
    const mockClient = { send: mockSend };

    // AwsKmsAdapter constructor takes (client: KMSClient, keyArn: string)
    // Since KMSClient is structural, passing an object with `send` works at runtime
    // Type assertion needed because mock doesn't carry full KMSClient type
    adapter = new AwsKmsAdapter(
      mockClient as unknown as import('@aws-sdk/client-kms').KMSClient, // mock KMSClient boundary
      keyArn,
    );
  });

  afterEach(() => {
    delete process.env['TEST_SECRET'];
  });

  describe('getSecret', () => {
    it('should decrypt a base64-encoded env var via KMS', async () => {
      const plaintext = 'my-decrypted-secret';
      const encoder = new TextEncoder();
      const plaintextBytes = encoder.encode(plaintext);

      process.env['TEST_SECRET'] = Buffer.from('encrypted-data').toString('base64');

      mockSend.mockResolvedValueOnce({
        Plaintext: plaintextBytes,
      });

      const result = await adapter.getSecret('TEST_SECRET');
      expect(result).toBe(plaintext);
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('should throw when env var is not set', async () => {
      delete process.env['TEST_SECRET'];

      await expect(adapter.getSecret('TEST_SECRET')).rejects.toThrow(
        'Environment variable TEST_SECRET is not set',
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('should throw when env var is empty string', async () => {
      process.env['TEST_SECRET'] = '';

      await expect(adapter.getSecret('TEST_SECRET')).rejects.toThrow(
        'Environment variable TEST_SECRET is not set',
      );
    });

    it('should throw when KMS returns invalid response', async () => {
      process.env['TEST_SECRET'] = Buffer.from('data').toString('base64');

      mockSend.mockResolvedValueOnce({
        Plaintext: undefined,
      });

      await expect(adapter.getSecret('TEST_SECRET')).rejects.toThrow();
    });
  });

  describe('listKeyVersions', () => {
    it('should return key metadata as a version entry', async () => {
      const creationDate = new Date('2025-01-15T10:00:00Z');

      mockSend.mockResolvedValueOnce({
        KeyMetadata: {
          KeyId: 'test-key-id',
          CreationDate: creationDate,
          KeyState: 'Enabled',
        },
      });

      const versions = await adapter.listKeyVersions('test-key-id');
      expect(versions).toHaveLength(1);
      expect(versions[0]).toEqual({
        versionId: 'test-key-id',
        createdAt: '2025-01-15T10:00:00.000Z',
        status: 'Enabled',
      });
    });

    it('should return empty array when KeyMetadata is absent', async () => {
      mockSend.mockResolvedValueOnce({});

      const versions = await adapter.listKeyVersions('missing-key');
      expect(versions).toHaveLength(0);
    });

    it('should handle missing optional fields gracefully', async () => {
      mockSend.mockResolvedValueOnce({
        KeyMetadata: {
          KeyId: 'test-key-id',
        },
      });

      const versions = await adapter.listKeyVersions('test-key-id');
      expect(versions).toHaveLength(1);
      expect(versions[0]?.versionId).toBe('test-key-id');
      expect(versions[0]?.status).toBe('Enabled');
    });
  });
});

// ─── LocalKmsAdapter ────────────────────────────────────────────────────────

describe('LocalKmsAdapter', () => {
  let adapter: KmsAdapter;

  beforeEach(() => {
    adapter = new LocalKmsAdapter();
  });

  afterEach(() => {
    delete process.env['LOCAL_SECRET'];
  });

  describe('getSecret', () => {
    it('should return env var value directly', async () => {
      process.env['LOCAL_SECRET'] = 'plain-secret-value';

      const result = await adapter.getSecret('LOCAL_SECRET');
      expect(result).toBe('plain-secret-value');
    });

    it('should throw when env var is not set', async () => {
      delete process.env['LOCAL_SECRET'];

      await expect(adapter.getSecret('LOCAL_SECRET')).rejects.toThrow(
        'Environment variable LOCAL_SECRET is not set',
      );
    });

    it('should throw when env var is empty', async () => {
      process.env['LOCAL_SECRET'] = '';

      await expect(adapter.getSecret('LOCAL_SECRET')).rejects.toThrow(
        'Environment variable LOCAL_SECRET is not set',
      );
    });
  });

  describe('listKeyVersions', () => {
    it('should return a single local version when env var exists', async () => {
      process.env['LOCAL_SECRET'] = 'some-value';

      const versions = await adapter.listKeyVersions('LOCAL_SECRET');
      expect(versions).toHaveLength(1);
      expect(versions[0]?.versionId).toBe('local-v1');
      expect(versions[0]?.status).toBe('Active');
    });

    it('should return empty array when env var is not set', async () => {
      delete process.env['LOCAL_SECRET'];

      const versions = await adapter.listKeyVersions('LOCAL_SECRET');
      expect(versions).toHaveLength(0);
    });

    it('should return empty array when env var is empty', async () => {
      process.env['LOCAL_SECRET'] = '';

      const versions = await adapter.listKeyVersions('LOCAL_SECRET');
      expect(versions).toHaveLength(0);
    });
  });
});
