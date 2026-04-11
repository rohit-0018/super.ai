import { KmsService } from './kms.service';

describe('KmsService (local fallback)', () => {
  const svc = new KmsService();
  beforeAll(() => { delete process.env.AWS_KMS_KEY_ID; });

  it('round-trips a payload through envelope encryption', async () => {
    const plain = Buffer.from('super-secret-private-key-bytes');
    const env = await svc.encrypt(plain);
    expect(env.ciphertext).toBeDefined();
    expect(env.encryptedDek).toBeDefined();
    const out = await svc.decrypt(env);
    expect(out.toString()).toBe(plain.toString());
  });

  it('produces different ciphertexts for the same plaintext', async () => {
    const plain = Buffer.from('repeat-me');
    const a = await svc.encrypt(plain);
    const b = await svc.encrypt(plain);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });
});
