import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Keypair, Connection } from '@solana/web3.js';
import { getSolanaRpcUrl } from '../common/network-config';
import { PrismaService } from '../prisma/prisma.service';
import { WalletsService } from '../wallets/wallets.service';
import { HeliusService } from './helius.service';

export interface HotSession {
  keypair: Keypair;
  /** Confirmed commitment — use for getSignatureStatuses, getBalance. */
  connection: Connection;
  /**
   * Processed commitment, staked endpoint — use for sendRawTransaction only.
   * "processed" lets Helius accept the tx immediately without waiting for
   * validator agreement; combined with the staked endpoint this maximises
   * landing rate.
   */
  sendConnection: Connection;
  walletId: string;
  address: string;
  expiresAt: number;
  balanceLamports?: number;
}

export interface CachedSnipeConfig {
  id: string;
  userId: string;
  enabled: boolean;
  chain: 'SOLANA' | 'EVM';
  walletId: string;
  buyAmountRaw: string;
  maxSlippageBps: number;
  groupIds: string[];
  skipSafety: boolean;
  dedupeWindowMs: number;
  notifyOnBuy: boolean;
  matchPattern: string | null;
  notifyTgChatId?: string | null;
}

/**
 * Manages per-user hot wallet sessions and group-config cache.
 * Hot session = decrypted Keypair held in memory so we skip KMS on every snipe.
 * Config cache = group→configs map to avoid DB hit per message.
 */
@Injectable()
export class SnipeSessionService implements OnModuleDestroy {
  private readonly logger = new Logger(SnipeSessionService.name);

  // userId → HotSession (keypair in memory). This is the *primary* session
  // used by the Telegram-driven sniper. There is one primary per user, tied
  // to SnipeConfig.walletId.
  private sessions = new Map<string, HotSession>();

  // userId → walletId → HotSession. Burst mode (parallel-wallet sniping)
  // keeps a hot session per Solana wallet so we can sign N transactions
  // simultaneously without paying KMS round-trips per fire. Separate from
  // `sessions` so the existing tg-snipe code path is untouched.
  private burstSessions = new Map<string, Map<string, HotSession>>();

  // groupId → { configs, cachedAt }
  private groupCache = new Map<string, { configs: CachedSnipeConfig[]; cachedAt: number }>();
  private readonly GROUP_CACHE_TTL = 30_000; // 30 s

  // address → last-seen timestamp (dedup across all users)
  // Hard-capped: high-volume groups can push hundreds of unique addresses/min,
  // faster than the 5-min TTL sweep can age them out. Insertion-order Map +
  // delete-oldest keeps memory bounded.
  private seen = new Map<string, number>();
  private readonly SEEN_MAX_ENTRIES = 5_000;

  private cleanupInterval: NodeJS.Timeout;

  constructor(
    private prisma: PrismaService,
    private wallets: WalletsService,
    private helius: HeliusService,
  ) {
    // Clean expired sessions + old dedupe entries every minute
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
  }

  onModuleDestroy() {
    clearInterval(this.cleanupInterval);
    this.sessions.clear();
    for (const map of this.burstSessions.values()) {
      for (const s of map.values()) s.keypair.secretKey.fill(0);
    }
    this.burstSessions.clear();
  }

  async startSession(userId: string, walletId: string): Promise<{ address: string; expiresAt: number; balanceLamports: number }> {
    const wallet = await this.prisma.wallet.findFirst({ where: { id: walletId, userId } });
    if (!wallet) throw new Error('Wallet not found');
    if (wallet.chain !== 'SOLANA') throw new Error('Only SOLANA wallets supported for hot sessions right now');

    // Decrypt key once; Keypair.fromSecretKey copies the bytes internally
    // so zeroing the buffer in withSigningKey's finally block is safe.
    const keypair = await this.wallets.withSigningKey(userId, walletId, async (key) => {
      const bytes = new Uint8Array([...key]); // deep copy before key is zeroed
      return Keypair.fromSecretKey(bytes);
    });

    // Dual connections: reads on confirmed, sends on processed/staked
    const connection     = this.helius.makeReadConnection();
    const sendConnection = this.helius.makeSendConnection();

    const expiresAt = Date.now() + 3_600_000; // 1 h
    this.sessions.set(userId, {
      keypair, connection, sendConnection,
      walletId, address: wallet.address, expiresAt,
    });

    // Persist session expiry so restart can detect stale state
    await this.prisma.snipeConfig.upsert({
      where: { userId },
      update: { sessionExpiresAt: new Date(expiresAt) },
      create: {
        userId,
        walletId,
        enabled: false,
        sessionExpiresAt: new Date(expiresAt),
      },
    });

    // Fetch balance (non-blocking)
    let balanceLamports = 0;
    try { balanceLamports = await connection.getBalance(keypair.publicKey); } catch {}

    this.logger.log(`Hot session started: user=${userId} wallet=${wallet.address} balance=${balanceLamports} expires=${new Date(expiresAt).toISOString()}`);
    return { address: wallet.address, expiresAt, balanceLamports };
  }

  stopSession(userId: string) {
    const session = this.sessions.get(userId);
    if (session) {
      // Zero keypair bytes (best effort — JS GC will handle the rest)
      session.keypair.secretKey.fill(0);
      this.sessions.delete(userId);
    }
    this.prisma.snipeConfig.updateMany({
      where: { userId },
      data: { sessionExpiresAt: null },
    }).catch(() => {});
    this.logger.log(`Hot session stopped: user=${userId}`);
  }

  // ── Burst (multi-wallet) sessions ────────────────────────────────────────

  /**
   * Decrypt every SOLANA wallet for the user into a HotSession. Skips wallets
   * that already have a live burst session. Returns the per-wallet summary
   * the UI uses to render the burst panel. Idempotent.
   */
  async startBurstSessions(userId: string): Promise<Array<{
    walletId: string; address: string; label: string | null;
    isPrimary: boolean; balanceLamports: number; expiresAt: number;
  }>> {
    const wallets = await this.prisma.wallet.findMany({
      where: { userId, chain: 'SOLANA' },
      select: { id: true, address: true, label: true, isPrimary: true },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });
    if (wallets.length === 0) throw new Error('No Solana wallets found for this user');

    const expiresAt = Date.now() + 3_600_000; // 1 h
    let map = this.burstSessions.get(userId);
    if (!map) { map = new Map(); this.burstSessions.set(userId, map); }

    const readConn = this.helius.makeReadConnection();
    const sendConn = this.helius.makeSendConnection();

    const out: Array<{ walletId: string; address: string; label: string | null; isPrimary: boolean; balanceLamports: number; expiresAt: number }> = [];

    for (const w of wallets) {
      let session = map.get(w.id);
      if (!session || session.expiresAt < Date.now()) {
        const keypair = await this.wallets.withSigningKey(userId, w.id, async (key) => {
          const bytes = new Uint8Array([...key]);
          return Keypair.fromSecretKey(bytes);
        });
        session = {
          keypair, connection: readConn, sendConnection: sendConn,
          walletId: w.id, address: w.address, expiresAt,
        };
        map.set(w.id, session);
      }
      let balanceLamports = 0;
      try { balanceLamports = await session.connection.getBalance(session.keypair.publicKey); } catch {}
      session.balanceLamports = balanceLamports;
      out.push({
        walletId: w.id, address: w.address, label: w.label,
        isPrimary: w.isPrimary, balanceLamports, expiresAt: session.expiresAt,
      });
    }
    this.logger.log(`Burst sessions started: user=${userId} wallets=${out.length}`);
    return out;
  }

  stopBurstSessions(userId: string) {
    const map = this.burstSessions.get(userId);
    if (!map) return;
    for (const s of map.values()) s.keypair.secretKey.fill(0);
    this.burstSessions.delete(userId);
    this.logger.log(`Burst sessions stopped: user=${userId}`);
  }

  /** Returns all live burst sessions for a user (filters expired). */
  getBurstSessions(userId: string): HotSession[] {
    const map = this.burstSessions.get(userId);
    if (!map) return [];
    const now = Date.now();
    const live: HotSession[] = [];
    for (const [walletId, s] of map) {
      if (s.expiresAt < now) {
        s.keypair.secretKey.fill(0);
        map.delete(walletId);
        continue;
      }
      live.push(s);
    }
    return live;
  }

  burstStatus(userId: string) {
    const sessions = this.getBurstSessions(userId);
    return {
      active: sessions.length > 0,
      count: sessions.length,
      wallets: sessions.map((s) => ({
        walletId: s.walletId, address: s.address,
        balanceLamports: s.balanceLamports ?? null,
        expiresAt: new Date(s.expiresAt),
      })),
    };
  }

  getSession(userId: string): HotSession | null {
    const s = this.sessions.get(userId);
    if (!s) return null;
    if (s.expiresAt < Date.now()) {
      this.sessions.delete(userId);
      return null;
    }
    return s;
  }

  hasActiveSession(userId: string): boolean {
    return this.getSession(userId) !== null;
  }

  /** Returns true when this address was already seen within the user's dedupe window. */
  isDuplicate(userId: string, address: string, windowMs: number): boolean {
    const key = `${userId}:${address}`;
    const last = this.seen.get(key);
    if (last !== undefined && Date.now() - last < windowMs) return true;
    // Re-insert to refresh insertion order; evict oldest when over cap.
    this.seen.delete(key);
    this.seen.set(key, Date.now());
    if (this.seen.size > this.SEEN_MAX_ENTRIES) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return false;
  }

  /** Fetch all enabled SnipeConfigs for a given Telegram group/channel. Result cached 30 s. */
  async getConfigsForGroup(groupId: string): Promise<CachedSnipeConfig[]> {
    const entry = this.groupCache.get(groupId);
    if (entry && Date.now() - entry.cachedAt < this.GROUP_CACHE_TTL) return entry.configs;

    const [rows, overrides] = await Promise.all([
      this.prisma.snipeConfig.findMany({ where: { enabled: true, groupIds: { has: groupId } } }),
      this.prisma.snipeGroupOverride.findMany({ where: { groupId } }),
    ]);

    const overrideMap = new Map(overrides.map((o) => [o.userId, o]));

    const configs: CachedSnipeConfig[] = rows.map((r) => {
      const ov = overrideMap.get(r.userId);
      return {
        id: r.id,
        userId: r.userId,
        enabled: r.enabled,
        chain: r.chain as 'SOLANA' | 'EVM',
        walletId: r.walletId,
        buyAmountRaw: r.buyAmountRaw,
        maxSlippageBps: r.maxSlippageBps,
        groupIds: r.groupIds,
        skipSafety: r.skipSafety,
        dedupeWindowMs: r.dedupeWindowMs,
        notifyOnBuy: r.notifyOnBuy,
        // Per-group pattern overrides global; null = match everything
        matchPattern: (ov as any)?.matchPattern ?? (r as any).matchPattern ?? null,
      };
    });

    this.groupCache.set(groupId, { configs, cachedAt: Date.now() });
    return configs;
  }

  /** Called by SnipeController after config save to invalidate stale group cache. */
  invalidateGroupCache(groupId?: string) {
    if (groupId) {
      this.groupCache.delete(groupId);
    } else {
      this.groupCache.clear();
    }
  }

  private cleanup() {
    const now = Date.now();
    for (const [userId, s] of this.sessions) {
      if (s.expiresAt < now) {
        s.keypair.secretKey.fill(0);
        this.sessions.delete(userId);
        this.logger.debug(`Auto-expired hot session: user=${userId}`);
      }
    }
    for (const [userId, map] of this.burstSessions) {
      for (const [walletId, s] of map) {
        if (s.expiresAt < now) {
          s.keypair.secretKey.fill(0);
          map.delete(walletId);
        }
      }
      if (map.size === 0) this.burstSessions.delete(userId);
    }
    // Prune dedupe entries older than 5 min
    for (const [key, ts] of this.seen) {
      if (now - ts > 300_000) this.seen.delete(key);
    }
  }

  sessionStatus(userId: string) {
    const s = this.sessions.get(userId);
    if (!s || s.expiresAt < Date.now()) return { active: false };
    return { active: true, address: s.address, expiresAt: new Date(s.expiresAt) };
  }

  async sessionStatusWithBalance(userId: string) {
    const s = this.sessions.get(userId);
    if (!s || s.expiresAt < Date.now()) return { active: false };
    let balanceLamports = 0;
    try { balanceLamports = await s.connection.getBalance(s.keypair.publicKey); } catch {}
    return { active: true, address: s.address, expiresAt: new Date(s.expiresAt), balanceLamports };
  }
}
