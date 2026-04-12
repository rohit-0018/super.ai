import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Chain } from '@prisma/client';
import { Keypair } from '@solana/web3.js';
import { ethers } from 'ethers';
import bs58 from 'bs58';
import { getSolanaRpcUrl, getEvmRpcUrl, isTestnet } from '../common/network-config';
import { PrismaService } from '../prisma/prisma.service';
import { KmsService } from './kms.service';

const MAX_WALLETS_PER_USER = 5;

@Injectable()
export class WalletsService {
  constructor(private prisma: PrismaService, private kms: KmsService) {}

  /** Fast list — no RPC calls, returns instantly from DB. */
  async list(userId: string) {
    const rows = await this.prisma.wallet.findMany({
      where: { userId },
      select: { id: true, chain: true, address: true, label: true, isPrimary: true, createdAt: true },
    });
    // Attach paper balances (from trades)
    const paperBalances = await this.prisma.paperBalance.findMany({ where: { userId } });
    const trades = await this.prisma.trade.findMany({
      where: { userId },
      select: { tokenIn: true, tokenOut: true, amountIn: true, amountOut: true, priceUsd: true, mode: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return rows.map((w) => {
      const pb = paperBalances.find((p) => p.token === w.address);
      const walletTrades = trades.filter(
        (t) => t.tokenIn.includes(w.chain === 'SOLANA' ? 'SOL' : 'ETH') ||
               t.tokenOut.includes(w.chain === 'SOLANA' ? 'SOL' : 'ETH'),
      );
      return {
        ...w,
        paperBalance: pb?.amount ?? null,
        recentTrades: walletTrades.slice(0, 5).map((t) => ({
          tokenIn: t.tokenIn,
          tokenOut: t.tokenOut,
          amountIn: t.amountIn,
          amountOut: t.amountOut,
          priceUsd: t.priceUsd,
          mode: t.mode,
          createdAt: t.createdAt,
        })),
      };
    });
  }

  /** Separate endpoint — fetches live on-chain balance for a single wallet. */
  async getBalance(userId: string, walletId: string) {
    const wallet = await this.prisma.wallet.findFirst({ where: { id: walletId, userId } });
    if (!wallet) throw new ForbiddenException();
    const balance = await this.fetchOnChainBalance(wallet.chain as 'SOLANA' | 'EVM', wallet.address);
    return { ...balance, walletId, chain: wallet.chain, address: wallet.address };
  }

  /** Fetch all wallet balances in parallel — used by dedicated balance endpoint. */
  async getAllBalances(userId: string) {
    const rows = await this.prisma.wallet.findMany({
      where: { userId },
      select: { id: true, chain: true, address: true },
    });
    const results = await Promise.allSettled(
      rows.map(async (w) => {
        const bal = await this.fetchOnChainBalance(w.chain as 'SOLANA' | 'EVM', w.address);
        return { walletId: w.id, chain: w.chain, address: w.address, ...bal };
      }),
    );
    return results.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : { walletId: rows[i].id, chain: rows[i].chain, address: rows[i].address, native: 0, symbol: rows[i].chain === 'SOLANA' ? 'SOL' : 'ETH', usd: 0, error: (r.reason as Error)?.message },
    );
  }

  private async fetchOnChainBalance(chain: 'SOLANA' | 'EVM', address: string): Promise<{ native: number; symbol: string; usd: number }> {
    if (chain === 'SOLANA') {
      const { Connection, PublicKey, LAMPORTS_PER_SOL } = await import('@solana/web3.js');
      const conn = new Connection(getSolanaRpcUrl(), { commitment: 'confirmed' });
      const lamports = await conn.getBalance(new PublicKey(address));
      const sol = lamports / LAMPORTS_PER_SOL;
      const solPrice = await this.getPrice('solana').catch(() => 140);
      return { native: sol, symbol: 'SOL', usd: sol * solPrice };
    }
    const provider = new ethers.JsonRpcProvider(getEvmRpcUrl());
    const wei = await provider.getBalance(address);
    const eth = parseFloat(ethers.formatEther(wei));
    const ethPrice = await this.getPrice('ethereum').catch(() => 2500);
    return { native: eth, symbol: 'ETH', usd: eth * ethPrice };
  }

  private priceCache = new Map<string, { price: number; ts: number }>();

  private async getPrice(coinId: string): Promise<number> {
    const cached = this.priceCache.get(coinId);
    if (cached && Date.now() - cached.ts < 60_000) return cached.price;
    try {
      const resp = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`);
      const data = await resp.json();
      const price = data?.[coinId]?.usd ?? (coinId === 'solana' ? 140 : 2500);
      this.priceCache.set(coinId, { price, ts: Date.now() });
      return price;
    } catch {
      return coinId === 'solana' ? 140 : 2500;
    }
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
    const conn = new Connection(getSolanaRpcUrl());
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
    const provider = new ethers.JsonRpcProvider(getEvmRpcUrl());
    const wallet = new ethers.Wallet('0x' + secret.toString('hex'), provider);
    const tx = await wallet.sendTransaction({
      to,
      value: ethers.parseEther(amount.toString()),
    });
    await tx.wait(1);
    return tx.hash;
  }

  async faucet(userId: string, walletId: string): Promise<{ success: boolean; message: string; txHash?: string; address?: string }> {
    if (!isTestnet()) {
      throw new ForbiddenException('Faucet only available in testnet mode');
    }
    const wallet = await this.prisma.wallet.findFirst({ where: { id: walletId, userId } });
    if (!wallet) throw new ForbiddenException('Wallet not found');

    if (wallet.chain === 'SOLANA') {
      const { Connection, PublicKey, LAMPORTS_PER_SOL } = await import('@solana/web3.js');
      const conn = new Connection(getSolanaRpcUrl());
      const pubkey = new PublicKey(wallet.address);

      // Try programmatic airdrop first (often rate-limited)
      try {
        const sig = await conn.requestAirdrop(pubkey, 2 * LAMPORTS_PER_SOL);
        await conn.confirmTransaction(sig);
        return { success: true, message: `Airdropped 2 SOL to ${wallet.address} on devnet`, txHash: sig };
      } catch {
        // Rate limited — try web faucet API as fallback
      }

      // Fallback: call the web faucet API directly
      try {
        const resp = await fetch('https://faucet.solana.com/api/request-airdrop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ walletAddress: wallet.address, network: 'devnet', amount: 1 }),
        });
        if (resp.ok) {
          const data = await resp.json();
          return { success: true, message: `Airdropped via web faucet to ${wallet.address}`, txHash: data?.txSignature ?? 'pending' };
        }
      } catch {
        // Web faucet also failed
      }

      return {
        success: false,
        message: `Devnet faucets are rate-limited. Open https://faucet.solana.com in your browser, paste: ${wallet.address}`,
        address: wallet.address,
      };
    }

    return {
      success: false,
      message: `Get testnet ETH from https://www.alchemy.com/faucets/ethereum-sepolia — paste: ${wallet.address}`,
      address: wallet.address,
    };
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
