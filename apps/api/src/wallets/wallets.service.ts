import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Chain } from '@prisma/client';
import { Keypair } from '@solana/web3.js';
import { ethers } from 'ethers';
import bs58 from 'bs58';
import { getSolanaRpcUrl, getEvmRpcUrl, isTestnet } from '../common/network-config';
import { PrismaService } from '../prisma/prisma.service';
import { KmsService } from './kms.service';
import { LiveTradeGuardService } from '../common/live-trade-guard.service';

const MAX_WALLETS_PER_USER = 5;

export interface HoldingRow {
  mint: string;
  symbol: string;
  amount: number;
  decimals: number;
  priceUsd: number | null;
  valueUsd: number | null;
  entryCostSol: number | null;
  entryCostUsd: number | null;
  pnlUsd: number | null;
  pnlPct: number | null;
  firstBoughtAt: string | null;
  txHash: string | null;
}

@Injectable()
export class WalletsService {
  constructor(
    private prisma: PrismaService,
    private kms: KmsService,
    private liveGuard: LiveTradeGuardService,
  ) {}

  /** Fast list — no RPC calls, returns instantly from DB. */
  async list(userId: string) {
    const rows = await this.prisma.wallet.findMany({
      where: { userId },
      select: { id: true, chain: true, address: true, label: true, isPrimary: true, isImported: true, backedUpAt: true, createdAt: true },
    });
    // Attach paper balances (from trades)
    const paperBalances = await this.prisma.paperBalance.findMany({ where: { userId } });
    const trades = await this.prisma.trade.findMany({
      where: { userId },
      select: { side: true, tokenIn: true, tokenOut: true, amountIn: true, amountOut: true, priceUsd: true, mode: true, createdAt: true },
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
          side: t.side,
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

  // Balance cache: walletId → { bal, ts }
  private balanceCache = new Map<string, { bal: any; ts: number }>();
  private readonly BAL_CACHE_TTL = 30_000; // 30 seconds
  private solConn: any = null;
  private evmProvider: any = null;
  private readonly logger = new Logger(WalletsService.name);

  // Well-known SPL tokens with stable prices — mint address → metadata
  private readonly SPL_KNOWN: Record<string, { symbol: string; price: number }> = {
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', price: 1 },
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: 'USDT', price: 1 },
    bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1: { symbol: 'bSOL', price: 0 },
    mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: { symbol: 'mSOL', price: 0 },
  };

  private readonly SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

  /** Probes RPC URLs once, caches the first working connection. */
  private async getSolanaConnection(): Promise<any> {
    if (this.solConn) return this.solConn;
    const { Connection } = await import('@solana/web3.js');
    const urls = [
      getSolanaRpcUrl(),
      ...(process.env.SOLANA_RPC_FALLBACK_URLS ?? '').split(',').map((u) => u.trim()).filter(Boolean),
    ].filter((u, i, a) => a.indexOf(u) === i);

    for (const url of urls) {
      try {
        const conn = new Connection(url, 'confirmed');
        await conn.getSlot();
        this.solConn = conn;
        return conn;
      } catch (err) {
        this.logger.warn(`Solana RPC ${url} unreachable: ${(err as any)?.message}`);
      }
    }
    throw new Error('All Solana RPC endpoints failed');
  }

  /** Fetches balances for all user wallets.
   *  Solana: one batched getMultipleAccountsInfo call + parallel token account fetches.
   *  EVM: parallel individual calls (no on-chain batching without a multicall contract).
   */
  async getAllBalances(userId: string) {
    const rows = await this.prisma.wallet.findMany({
      where: { userId },
      select: { id: true, chain: true, address: true },
    });

    const now = Date.now();
    const stale = (w: { id: string }) => {
      const c = this.balanceCache.get(w.id);
      return !c || now - c.ts >= this.BAL_CACHE_TTL;
    };

    const staleSol = rows.filter((w) => w.chain === 'SOLANA' && stale(w));
    const staleEvm = rows.filter((w) => w.chain === 'EVM' && stale(w));

    await Promise.all([
      staleSol.length > 0 ? this.fetchSolanaBalancesBatch(staleSol) : Promise.resolve(),
      ...staleEvm.map((w) => this.fetchEvmBalance(w)),
    ]);

    return rows.map((w) => {
      const entry = this.balanceCache.get(w.id);
      return entry?.bal ?? { walletId: w.id, chain: w.chain, address: w.address, native: 0, symbol: w.chain === 'SOLANA' ? 'SOL' : 'ETH', usd: 0, error: 'Balance unavailable' };
    });
  }

  /** One getMultipleAccountsInfo call for all Solana wallets + parallel token account fetches. */
  private async fetchSolanaBalancesBatch(wallets: { id: string; chain: string; address: string }[]) {
    const { PublicKey, LAMPORTS_PER_SOL } = await import('@solana/web3.js');

    let conn: any;
    try {
      conn = await this.withTimeout(this.getSolanaConnection(), 10_000);
    } catch (e: any) {
      this.logger.warn(`Solana connection failed: ${e.message}`);
      for (const w of wallets) {
        if (!this.balanceCache.get(w.id)) {
          this.balanceCache.set(w.id, { bal: { walletId: w.id, chain: w.chain, address: w.address, native: 0, symbol: 'SOL', usd: 0, error: e.message }, ts: 0 });
        }
      }
      return;
    }

    const pubkeys = wallets.map((w) => new PublicKey(w.address));

    // Single batched call for native balances + parallel token account fetches — all in one round trip
    const [accountInfos, ...tokenResults] = await Promise.all([
      conn.getMultipleAccountsInfo(pubkeys),
      ...wallets.map((w) =>
        conn.getParsedTokenAccountsByOwner(new PublicKey(w.address), {
          programId: new PublicKey(this.SPL_TOKEN_PROGRAM),
        }).catch(() => ({ value: [] as any[] })),
      ),
    ]);

    const solPrice = await this.getPrice('solana').catch(() => 140);

    wallets.forEach((w, i) => {
      const sol = ((accountInfos[i] as any)?.lamports ?? 0) / LAMPORTS_PER_SOL;
      const tokenAccts: any[] = (tokenResults[i] as any).value ?? [];

      const tokens = tokenAccts
        .map((acct: any) => {
          const info = acct.account.data?.parsed?.info;
          if (!info) return null;
          const amount: number = info.tokenAmount?.uiAmount ?? 0;
          if (amount === 0) return null;
          const mint: string = info.mint;
          const known = this.SPL_KNOWN[mint];
          return { mint, symbol: known?.symbol ?? mint.slice(0, 6) + '…', amount, usd: known ? amount * known.price : 0 };
        })
        .filter((t): t is NonNullable<typeof t> => t !== null);

      const tokensUsd = tokens.reduce((s, t) => s + t.usd, 0);
      const bal = {
        walletId: w.id, chain: w.chain, address: w.address,
        native: sol, symbol: 'SOL', usd: sol * solPrice + tokensUsd,
        ...(tokens.length > 0 && { tokens }),
      };
      this.balanceCache.set(w.id, { bal, ts: Date.now() });
    });
  }

  private async fetchEvmBalance(w: { id: string; chain: string; address: string }) {
    try {
      if (!this.evmProvider) this.evmProvider = new ethers.JsonRpcProvider(getEvmRpcUrl());
      const wei: bigint = await this.withTimeout(this.evmProvider.getBalance(w.address), 10_000);
      const eth = parseFloat(ethers.formatEther(wei));
      const ethPrice = await this.getPrice('ethereum').catch(() => 2500);
      const bal = { walletId: w.id, chain: w.chain, address: w.address, native: eth, symbol: 'ETH', usd: eth * ethPrice };
      this.balanceCache.set(w.id, { bal, ts: Date.now() });
    } catch (e: any) {
      this.logger.warn(`EVM balance fetch failed for ${w.id}: ${e.message}`);
      const stale = this.balanceCache.get(w.id);
      if (stale) this.balanceCache.set(w.id, { bal: { ...stale.bal, stale: true }, ts: stale.ts });
    }
  }

  /** Used by GET /wallets/:id/balance — single wallet, reuses cached connection. */
  async fetchOnChainBalance(chain: 'SOLANA' | 'EVM', address: string): Promise<{
    native: number; symbol: string; usd: number;
    tokens?: Array<{ mint: string; symbol: string; amount: number; usd: number }>;
  }> {
    if (chain === 'SOLANA') {
      const { PublicKey, LAMPORTS_PER_SOL } = await import('@solana/web3.js');
      const conn = await this.getSolanaConnection();
      const pubkey = new PublicKey(address);
      const [lamports, tokenResult] = await Promise.all([
        conn.getBalance(pubkey),
        conn.getParsedTokenAccountsByOwner(pubkey, {
          programId: new PublicKey(this.SPL_TOKEN_PROGRAM),
        }).catch(() => ({ value: [] as any[] })),
      ]);
      const sol = lamports / LAMPORTS_PER_SOL;
      const solPrice = await this.getPrice('solana').catch(() => 140);
      type SplToken = { mint: string; symbol: string; amount: number; usd: number };
      const tokens = (tokenResult.value as any[])
        .map((acct: any): SplToken | null => {
          const info = acct.account.data?.parsed?.info;
          if (!info) return null;
          const amount: number = info.tokenAmount?.uiAmount ?? 0;
          if (amount === 0) return null;
          const mint: string = info.mint;
          const known = this.SPL_KNOWN[mint];
          return { mint, symbol: known?.symbol ?? mint.slice(0, 6) + '…', amount, usd: known ? amount * known.price : 0 };
        })
        .filter((t: SplToken | null): t is SplToken => t !== null);
      const tokensUsd = tokens.reduce((s: number, t: SplToken) => s + t.usd, 0);
      return { native: sol, symbol: 'SOL', usd: sol * solPrice + tokensUsd, ...(tokens.length > 0 && { tokens }) };
    }
    if (!this.evmProvider) this.evmProvider = new ethers.JsonRpcProvider(getEvmRpcUrl());
    const wei = await this.evmProvider.getBalance(address);
    const eth = parseFloat(ethers.formatEther(wei));
    const ethPrice = await this.getPrice('ethereum').catch(() => 2500);
    return { native: eth, symbol: 'ETH', usd: eth * ethPrice };
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`Timeout after ${ms}ms`)), ms)),
    ]);
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

  // ── Holdings endpoint ────────────────────────────────────────────────────────

  /**
   * Returns all non-zero SPL token positions for a Solana wallet,
   * enriched with Birdeye prices and P&L from snipe trade history.
   */
  async getHoldings(userId: string, walletId: string): Promise<HoldingRow[]> {
    const wallet = await this.prisma.wallet.findFirst({ where: { id: walletId, userId } });
    if (!wallet) throw new ForbiddenException();

    if (wallet.chain !== 'SOLANA') {
      // EVM: no token-account model; return empty for now
      return [];
    }

    const { PublicKey, LAMPORTS_PER_SOL } = await import('@solana/web3.js');
    const conn = await this.getSolanaConnection();
    const pubkey = new PublicKey(wallet.address);

    // Fetch native balance + SPL token accounts in one round-trip
    const [lamports, tokenResult] = await Promise.all([
      conn.getBalance(pubkey).catch(() => 0),
      conn.getParsedTokenAccountsByOwner(pubkey, {
        programId: new PublicKey(this.SPL_TOKEN_PROGRAM),
      }).catch(() => ({ value: [] as any[] })),
    ]);

    // Build raw token list (non-zero amounts only)
    const rawTokens: Array<{ mint: string; symbol: string; amount: number; decimals: number }> = [];
    for (const acct of (tokenResult.value as any[])) {
      const info = acct.account.data?.parsed?.info;
      if (!info) continue;
      const amount: number = info.tokenAmount?.uiAmount ?? 0;
      if (amount === 0) continue;
      const mint: string = info.mint;
      const decimals: number = info.tokenAmount?.decimals ?? 9;
      const known = this.SPL_KNOWN[mint];
      rawTokens.push({ mint, symbol: known?.symbol ?? mint.slice(0, 6) + '…', amount, decimals });
    }

    if (rawTokens.length === 0 && lamports === 0) return [];

    const mints = rawTokens.map((t) => t.mint);

    // Batch-price all mints via Birdeye multi-price
    const priceMap = await this.batchTokenPrices(mints);

    // SOL price for P&L calculations
    const solPrice = await this.getPrice('solana').catch(() => 140);

    // Fetch snipe trades for these mints — used for P&L
    const snipeTrades = mints.length > 0
      ? await this.prisma.snipeTrade.findMany({
          where: { userId, mint: { in: mints } },
          orderBy: { createdAt: 'asc' }, // oldest first so we use first buy as cost basis
        })
      : [];

    const snipeByMint = new Map<string, (typeof snipeTrades[0])[]>();
    for (const t of snipeTrades) {
      const arr = snipeByMint.get(t.mint) ?? [];
      arr.push(t);
      snipeByMint.set(t.mint, arr);
    }

    const rows: HoldingRow[] = rawTokens.map((t) => {
      const priceUsd = priceMap[t.mint] ?? null;
      const valueUsd = priceUsd !== null ? priceUsd * t.amount : null;

      // Aggregate all snipe buys for this mint
      const trades = snipeByMint.get(t.mint) ?? [];
      const totalSolSpent = trades.reduce((s, tr) => s + Number(tr.amountRaw) / LAMPORTS_PER_SOL, 0);
      const entryCostUsd = totalSolSpent > 0 ? totalSolSpent * solPrice : null;

      const pnlUsd   = valueUsd !== null && entryCostUsd !== null ? valueUsd - entryCostUsd : null;
      const pnlPct   = pnlUsd !== null && entryCostUsd ? (pnlUsd / entryCostUsd) * 100 : null;
      const firstBuy = trades.find((tr) => tr.status !== 'failed');

      return {
        mint: t.mint,
        symbol: t.symbol,
        amount: t.amount,
        decimals: t.decimals,
        priceUsd,
        valueUsd,
        entryCostSol: totalSolSpent > 0 ? totalSolSpent : null,
        entryCostUsd,
        pnlUsd,
        pnlPct,
        firstBoughtAt: firstBuy?.createdAt?.toISOString() ?? null,
        txHash: firstBuy?.txHash ?? null,
      };
    });

    return rows.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));
  }

  private async batchTokenPrices(mints: string[]): Promise<Record<string, number | null>> {
    if (mints.length === 0) return {};
    const birdeyeKey = process.env.BIRDEYE_API_KEY ?? '';
    const result: Record<string, number | null> = Object.fromEntries(mints.map((m) => [m, null]));

    // Birdeye first if we have a key
    if (birdeyeKey) {
      try {
        const url = `https://public-api.birdeye.so/defi/multi_price?list_address=${mints.join(',')}`;
        const resp = await fetch(url, {
          headers: { 'X-API-KEY': birdeyeKey },
          signal: AbortSignal.timeout(8_000),
        });
        if (resp.ok) {
          const data: any = await resp.json();
          for (const mint of mints) {
            const v = data?.data?.[mint]?.value;
            if (typeof v === 'number') result[mint] = v;
          }
        }
      } catch {
        /* fall through to DexScreener */
      }
    }

    // DexScreener fallback for any mints we couldn't price.
    // No key required, accepts comma-separated list of up to 30 token addresses.
    const missing = mints.filter((m) => result[m] == null);
    if (missing.length > 0) {
      try {
        for (let i = 0; i < missing.length; i += 30) {
          const batch = missing.slice(i, i + 30);
          const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${batch.join(',')}`, {
            signal: AbortSignal.timeout(8_000),
          });
          if (!res.ok) continue;
          const json: any = await res.json();
          const pairs: any[] = Array.isArray(json?.pairs) ? json.pairs : [];
          // Group pairs by base mint, keep highest-liquidity per mint.
          const byMint = new Map<string, any>();
          for (const p of pairs) {
            const m = p?.baseToken?.address;
            if (!m) continue;
            const cur = byMint.get(m);
            if (!cur || (p?.liquidity?.usd ?? 0) > (cur?.liquidity?.usd ?? 0)) byMint.set(m, p);
          }
          for (const m of batch) {
            const p = byMint.get(m);
            const px = Number(p?.priceUsd);
            if (Number.isFinite(px)) result[m] = px;
          }
        }
      } catch {
        /* leave nulls */
      }
    }

    // Pin known stablecoin prices that providers occasionally miss.
    for (const m of mints) {
      if (result[m] == null && this.SPL_KNOWN[m]?.price != null) {
        result[m] = this.SPL_KNOWN[m]!.price!;
      }
    }
    return result;
  }


  async create(userId: string, chain: Chain, label?: string) {
    const count = await this.prisma.wallet.count({ where: { userId } });
    if (count >= MAX_WALLETS_PER_USER) {
      throw new ForbiddenException(`Wallet cap reached (${MAX_WALLETS_PER_USER})`);
    }

    // Auto-generate a default label if none provided
    const chainCount = await this.prisma.wallet.count({ where: { userId, chain } });
    const defaultLabel = label ?? `${chain === 'SOLANA' ? 'Solana' : 'EVM'} Wallet ${chainCount + 1}`;

    const { address, secret } = this.generateKeypair(chain);
    const env = await this.kms.encrypt(secret);

    const wallet = await this.prisma.wallet.create({
      data: {
        userId,
        chain,
        address,
        encryptedKey: env.ciphertext,
        encryptedDek: env.encryptedDek,
        label: defaultLabel,
        isPrimary: count === 0,
        isImported: false,
      },
      select: { id: true, chain: true, address: true, label: true, isPrimary: true, isImported: true, backedUpAt: true, createdAt: true },
    });
    await this.prisma.auditLog.create({
      data: { userId, action: 'wallet.create', target: address, payload: { chain } },
    });

    // Return the plaintext private key ONE TIME so the frontend can prompt backup.
    // It is never stored in plaintext — this is the only moment the client sees it.
    const privateKey = chain === 'SOLANA' ? bs58.encode(secret) : '0x' + secret.toString('hex');
    return { ...wallet, privateKey };
  }

  /** Import an existing wallet by its private key. */
  async importWallet(userId: string, chain: Chain, rawKey: string, label?: string) {
    const count = await this.prisma.wallet.count({ where: { userId } });
    if (count >= MAX_WALLETS_PER_USER) {
      throw new ForbiddenException(`Wallet cap reached (${MAX_WALLETS_PER_USER})`);
    }

    let address: string;
    let secret: Buffer;

    try {
      if (chain === 'SOLANA') {
        const { Keypair } = await import('@solana/web3.js');
        const decoded = bs58.decode(rawKey.trim());
        const kp = Keypair.fromSecretKey(decoded);
        address = kp.publicKey.toBase58();
        secret = Buffer.from(decoded);
      } else {
        const normalised = rawKey.trim().startsWith('0x') ? rawKey.trim() : '0x' + rawKey.trim();
        const w = new ethers.Wallet(normalised);
        address = w.address;
        secret = Buffer.from(normalised.slice(2), 'hex');
      }
    } catch {
      throw new ForbiddenException('Invalid private key format');
    }

    const existing = await this.prisma.wallet.findFirst({ where: { userId, address } });
    if (existing) throw new ForbiddenException('This wallet is already in your account');

    const env = await this.kms.encrypt(secret);
    secret.fill(0);

    const wallet = await this.prisma.wallet.create({
      data: {
        userId,
        chain,
        address,
        encryptedKey: env.ciphertext,
        encryptedDek: env.encryptedDek,
        label: label ?? `Imported ${chain}`,
        isPrimary: count === 0,
        isImported: true,
        backedUpAt: new Date(), // user already has the key — mark as backed up
      },
      select: { id: true, chain: true, address: true, label: true, isPrimary: true, isImported: true, backedUpAt: true, createdAt: true },
    });
    await this.prisma.auditLog.create({
      data: { userId, action: 'wallet.import', target: address, payload: { chain } },
    });
    return wallet;
  }

  /** Called after user confirms they have saved their key. */
  async confirmBackup(userId: string, walletId: string) {
    await this.prisma.wallet.updateMany({
      where: { id: walletId, userId },
      data: { backedUpAt: new Date() },
    });
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

  async exportAll(userId: string): Promise<{ chain: string; address: string; label: string | null; isPrimary: boolean; privateKey: string }[]> {
    const wallets = await this.prisma.wallet.findMany({ where: { userId } });
    const out = await Promise.all(wallets.map(async (w) => {
      const secret = await this.kms.decrypt({ ciphertext: w.encryptedKey, encryptedDek: w.encryptedDek });
      const privateKey = w.chain === 'SOLANA' ? bs58.encode(secret) : '0x' + secret.toString('hex');
      return { chain: w.chain, address: w.address, label: w.label, isPrimary: w.isPrimary, privateKey };
    }));
    await this.prisma.auditLog.create({ data: { userId, action: 'wallet.export_all', target: `${wallets.length} wallets` } });
    return out;
  }

  async renameWallet(userId: string, walletId: string, label: string) {
    const wallet = await this.prisma.wallet.findFirst({ where: { id: walletId, userId } });
    if (!wallet) throw new ForbiddenException();
    return this.prisma.wallet.update({
      where: { id: walletId },
      data: { label: label || null },
      select: { id: true, chain: true, address: true, label: true, isPrimary: true, isImported: true, backedUpAt: true, createdAt: true },
    });
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
    await this.liveGuard.checkLiveWithdraw({ userId });
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
