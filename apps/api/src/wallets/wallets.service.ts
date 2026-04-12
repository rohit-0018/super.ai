import { ForbiddenException, Injectable } from '@nestjs/common';
import { Chain } from '@prisma/client';
import { Keypair } from '@solana/web3.js';
import { ethers } from 'ethers';
import bs58 from 'bs58';
import { PrismaService } from '../prisma/prisma.service';
import { KmsService } from './kms.service';

const MAX_WALLETS_PER_USER = 5;

@Injectable()
export class WalletsService {
  constructor(private prisma: PrismaService, private kms: KmsService) {}

  async list(userId: string) {
    const rows = await this.prisma.wallet.findMany({
      where: { userId },
      select: { id: true, chain: true, address: true, label: true, isPrimary: true, createdAt: true },
    });
    return rows;
  }

  async create(userId: string, chain: Chain, label?: string) {
    const count = await this.prisma.wallet.count({ where: { userId } });
    if (count >= MAX_WALLETS_PER_USER) {
      throw new ForbiddenException(`Wallet cap reached (${MAX_WALLETS_PER_USER})`);
    }

    const { address, secret } = this.generateKeypair(chain);
    const env = await this.kms.encrypt(secret);

    const wallet = await this.prisma.wallet.create({
      data: {
        userId,
        chain,
        address,
        encryptedKey: env.ciphertext,
        encryptedDek: env.encryptedDek,
        label,
        isPrimary: count === 0,
      },
      select: { id: true, chain: true, address: true, label: true, isPrimary: true, createdAt: true },
    });
    await this.prisma.auditLog.create({
      data: { userId, action: 'wallet.create', target: address, payload: { chain } },
    });
    return wallet;
  }

  async exportKey(userId: string, walletId: string): Promise<string> {
    const wallet = await this.prisma.wallet.findFirst({ where: { id: walletId, userId } });
    if (!wallet) throw new ForbiddenException();
    const secret = await this.kms.decrypt({
      ciphertext: wallet.encryptedKey,
      encryptedDek: wallet.encryptedDek,
    });
    await this.prisma.auditLog.create({
      data: { userId, action: 'wallet.export', target: wallet.address },
    });
    return wallet.chain === 'SOLANA' ? bs58.encode(secret) : '0x' + secret.toString('hex');
  }

  async setPrimary(userId: string, walletId: string) {
    await this.prisma.$transaction([
      this.prisma.wallet.updateMany({ where: { userId }, data: { isPrimary: false } }),
      this.prisma.wallet.update({ where: { id: walletId }, data: { isPrimary: true } }),
    ]);
    return this.list(userId);
  }

  /** Returns plaintext signing key only inside the caller's scope. */
  async withSigningKey<T>(userId: string, walletId: string, fn: (key: Buffer) => Promise<T>): Promise<T> {
    const wallet = await this.prisma.wallet.findFirst({ where: { id: walletId, userId } });
    if (!wallet) throw new ForbiddenException();
    const key = await this.kms.decrypt({
      ciphertext: wallet.encryptedKey,
      encryptedDek: wallet.encryptedDek,
    });
    try {
      return await fn(key);
    } finally {
      key.fill(0);
    }
  }

  async depositInfo(userId: string, walletId: string) {
    const wallet = await this.prisma.wallet.findFirst({
      where: { id: walletId, userId },
      select: { id: true, chain: true, address: true, label: true },
    });
    if (!wallet) throw new ForbiddenException();
    return {
      address: wallet.address,
      chain: wallet.chain,
      label: wallet.label,
      instructions:
        wallet.chain === 'SOLANA'
          ? 'Send SOL or SPL tokens to this address. Funds arrive in ~400ms.'
          : 'Send ETH or ERC-20 tokens to this address. Wait for block confirmation.',
    };
  }

  async withdraw(userId: string, walletId: string, toAddress: string, tokenMint: string, amount: number) {
    const wallet = await this.prisma.wallet.findFirst({ where: { id: walletId, userId } });
    if (!wallet) throw new ForbiddenException();
    const key = await this.kms.decrypt({
      ciphertext: wallet.encryptedKey,
      encryptedDek: wallet.encryptedDek,
    });
    try {
      let txHash: string;
      if (wallet.chain === 'SOLANA') {
        txHash = await this.withdrawSolana(key, toAddress, tokenMint, amount);
      } else {
        txHash = await this.withdrawEvm(key, toAddress, tokenMint, amount);
      }
      await this.prisma.auditLog.create({
        data: { userId, action: 'wallet.withdraw', target: wallet.address, payload: { toAddress, tokenMint, amount, txHash } as any },
      });
      return { txHash, chain: wallet.chain };
    } finally {
      key.fill(0);
    }
  }

  private async withdrawSolana(secret: Buffer, to: string, _mint: string, amount: number): Promise<string> {
    const { Connection, Transaction, SystemProgram, PublicKey, sendAndConfirmTransaction } = await import('@solana/web3.js');
    const kp = Keypair.fromSecretKey(secret);
    const conn = new Connection(process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com');
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: kp.publicKey,
        toPubkey: new PublicKey(to),
        lamports: Math.round(amount * 1e9),
      }),
    );
    const sig = await sendAndConfirmTransaction(conn, tx, [kp]);
    return sig;
  }

  private async withdrawEvm(secret: Buffer, to: string, _tokenAddress: string, amount: number): Promise<string> {
    const provider = new ethers.JsonRpcProvider(process.env.EVM_RPC_URL ?? 'https://eth.llamarpc.com');
    const wallet = new ethers.Wallet('0x' + secret.toString('hex'), provider);
    const tx = await wallet.sendTransaction({
      to,
      value: ethers.parseEther(amount.toString()),
    });
    await tx.wait(1);
    return tx.hash;
  }

  private generateKeypair(chain: Chain): { address: string; secret: Buffer } {
    if (chain === 'SOLANA') {
      const kp = Keypair.generate();
      return { address: kp.publicKey.toBase58(), secret: Buffer.from(kp.secretKey) };
    }
    const w = ethers.Wallet.createRandom();
    return { address: w.address, secret: Buffer.from(w.privateKey.slice(2), 'hex') };
  }
}
