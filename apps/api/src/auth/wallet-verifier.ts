import { Injectable } from '@nestjs/common';
import { Chain } from '@prisma/client';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { ethers } from 'ethers';

/**
 * Verifies a wallet signature against an issued nonce challenge.
 * - Solana: Ed25519 (tweetnacl) on UTF-8 nonce bytes, base58 sig.
 * - EVM:    secp256k1 personal_sign via ethers.verifyMessage.
 */
@Injectable()
export class WalletVerifier {
  verify(chain: Chain, address: string, nonce: string, signature: string): boolean {
    const message = this.challenge(nonce);
    try {
      if (chain === 'SOLANA') {
        const sig = bs58.decode(signature);
        const pub = bs58.decode(address);
        return nacl.sign.detached.verify(new TextEncoder().encode(message), sig, pub);
      }
      const recovered = ethers.verifyMessage(message, signature);
      return recovered.toLowerCase() === address.toLowerCase();
    } catch {
      return false;
    }
  }

  challenge(nonce: string): string {
    return `QWAI Sign-In\nNonce: ${nonce}`;
  }
}
