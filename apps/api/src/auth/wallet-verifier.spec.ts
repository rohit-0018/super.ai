import { WalletVerifier } from './wallet-verifier';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { ethers } from 'ethers';

describe('WalletVerifier', () => {
  const v = new WalletVerifier();

  it('verifies a valid Solana Ed25519 signature', () => {
    const kp = nacl.sign.keyPair();
    const nonce = 'abcd1234';
    const msg = new TextEncoder().encode(v.challenge(nonce));
    const sig = nacl.sign.detached(msg, kp.secretKey);
    const ok = v.verify('SOLANA', bs58.encode(kp.publicKey), nonce, bs58.encode(sig));
    expect(ok).toBe(true);
  });

  it('rejects a tampered Solana signature', () => {
    const kp = nacl.sign.keyPair();
    const ok = v.verify('SOLANA', bs58.encode(kp.publicKey), 'nonce', bs58.encode(new Uint8Array(64)));
    expect(ok).toBe(false);
  });

  it('verifies a valid EVM secp256k1 signature', async () => {
    const wallet = ethers.Wallet.createRandom();
    const nonce = 'evm-nonce';
    const sig = await wallet.signMessage(v.challenge(nonce));
    expect(v.verify('EVM', wallet.address, nonce, sig)).toBe(true);
  });

  it('rejects EVM signature for wrong address', async () => {
    const a = ethers.Wallet.createRandom();
    const b = ethers.Wallet.createRandom();
    const sig = await a.signMessage(v.challenge('x'));
    expect(v.verify('EVM', b.address, 'x', sig)).toBe(false);
  });
});
