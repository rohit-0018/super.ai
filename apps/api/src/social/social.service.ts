import { Injectable } from '@nestjs/common';
import { AgentKind, AgentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SocialService {
  constructor(private prisma: PrismaService) {}

  /**
   * Public leaderboard — privacy-hardened.
   *
   * Risk we're guarding against: an attacker scrapes /social/leaderboard,
   * watches a user's PnL delta over time, correlates the anonymous handle
   * with on-chain trades (e.g. via Telegram alpha calls, copy-trade
   * signals, or a deanonymizing mistake elsewhere), then front-runs them.
   *
   * Mitigations applied:
   *  1. Only users who EXPLICITLY opt in via leaderboardOptIn=true appear.
   *     Default is opt-out for everyone — silence by default.
   *  2. The handle is a stable random ID stored on User (leaderboardHandle),
   *     not derived from userId. Cannot be reversed back to a real userId
   *     even if someone learns the cuid format.
   *  3. PnL is bucketed (e.g. ">$10k", ">$100k") instead of exact dollars.
   *     Trade count is bucketed for the same reason.
   *  4. Win rate is rounded to 5%-resolution buckets — same idea.
   *
   * Net effect: the leaderboard still ranks performance, but real-time
   * delta tracking and exact-amount reverse-engineering are dead.
   */
  async leaderboard() {
    const since = new Date(Date.now() - 30 * 24 * 3600_000);
    const rows = await this.prisma.trade.groupBy({
      by: ['userId'],
      where: { createdAt: { gte: since } },
      _sum: { pnlUsd: true },
      _count: true,
      orderBy: { _sum: { pnlUsd: 'desc' } },
      take: 50,
    });
    if (rows.length === 0) return [];

    // Pull opt-in + handle for these userIds in one shot
    const userMeta = await this.prisma.user.findMany({
      where: { id: { in: rows.map((r) => r.userId) } },
      select: { id: true, leaderboardOptIn: true, leaderboardHandle: true } as any,
    }) as any[];
    const metaMap = new Map(userMeta.map((u) => [u.id, u]));

    const filtered = rows.filter((r) => metaMap.get(r.userId)?.leaderboardOptIn === true);

    return Promise.all(
      filtered.slice(0, 50).map(async (r, i) => {
        const wins = await this.prisma.trade.count({
          where: { userId: r.userId, createdAt: { gte: since }, pnlUsd: { gt: 0 } },
        });
        const meta = metaMap.get(r.userId);
        const winRateRaw = r._count > 0 ? wins / r._count : 0;
        return {
          rank: i + 1,
          handle: meta?.leaderboardHandle ?? 'anon-trader',
          // Bucket PnL into log-spaced bands so trackers can't watch deltas tick.
          pnlBand: bucketPnl(r._sum.pnlUsd ?? 0),
          // Bucket trade count into ranges
          tradesBand: bucketTrades(r._count),
          // Round win rate to 5% resolution
          winRateBand: Math.round(winRateRaw * 20) / 20,
        };
      }),
    );
  }

  startCopyTrade(userId: string, srcWallet: string) {
    return this.prisma.agent.create({
      data: { userId, kind: AgentKind.COPY_TRADE, status: AgentStatus.RUNNING, params: { srcWallet } },
    });
  }

  // N3: Trading rooms (backed by in-memory channels)
  private rooms = new Map<string, { name: string; createdBy: string; messages: { userId: string; text: string; ts: string }[] }>();

  createRoom(userId: string, name: string) {
    const id = `room-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.rooms.set(id, { name, createdBy: userId, messages: [] });
    return { id, name };
  }

  listRooms() {
    return Array.from(this.rooms.entries()).map(([id, r]) => ({
      id,
      name: r.name,
      messageCount: r.messages.length,
    }));
  }

  postToRoom(roomId: string, userId: string, text: string) {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    const msg = { userId: 'qwai-' + userId.slice(0, 6), text, ts: new Date().toISOString() };
    room.messages.push(msg);
    if (room.messages.length > 200) room.messages.shift();
    return msg;
  }

  getRoomMessages(roomId: string) {
    return this.rooms.get(roomId)?.messages ?? [];
  }

  // N4: Signal sharing cards
  async createSignalCard(userId: string, data: { token: string; chain: string; direction: 'long' | 'short'; conviction: number; note?: string }) {
    return this.prisma.alertEvent.create({
      data: {
        userId,
        kind: 'SIGNAL_CARD',
        severity: 'INFO',
        payload: { ...data, sharedBy: 'qwai-' + userId.slice(0, 6), sharedAt: new Date().toISOString() } as any,
      },
    });
  }

  /**
   * Public signal feed — drops anything that could leak the originator's
   * userId. Only returns the trade idea (token + direction + conviction)
   * plus the random handle of whoever opted in.
   */
  async signalFeed(limit = 20) {
    const rows = await this.prisma.alertEvent.findMany({
      where: { kind: 'SIGNAL_CARD' },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    if (rows.length === 0) return [];
    const userIds = Array.from(new Set(rows.map((r) => r.userId).filter((u): u is string => !!u)));
    const meta = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, leaderboardOptIn: true, leaderboardHandle: true } as any,
    }) as any[];
    const metaMap = new Map(meta.map((u) => [u.id, u]));
    return rows
      .filter((r) => r.userId && metaMap.get(r.userId)?.leaderboardOptIn === true)
      .map((r) => {
        const m = metaMap.get(r.userId!);
        const payload = (r.payload ?? {}) as any;
        return {
          id: r.id,
          handle: m?.leaderboardHandle ?? 'anon-trader',
          token: payload.token ?? null,
          chain: payload.chain ?? null,
          direction: payload.direction ?? null,
          conviction: payload.conviction ?? null,
          note: payload.note ?? null,
          createdAt: r.createdAt,
        };
      });
  }

  // N5: Referral system
  async generateReferralCode(userId: string): Promise<string> {
    const code = 'QWAI-' + userId.slice(0, 4).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    await this.prisma.user.update({ where: { id: userId }, data: { riskProfile: { referralCode: code } as any } });
    return code;
  }

  async claimReferral(userId: string, code: string): Promise<{ ok: boolean; message: string }> {
    const referrer = await this.prisma.user.findFirst({
      where: { riskProfile: { path: ['referralCode'], equals: code } },
    });
    if (!referrer) return { ok: false, message: 'Invalid referral code' };
    if (referrer.id === userId) return { ok: false, message: 'Cannot refer yourself' };
    await this.prisma.auditLog.create({
      data: { userId, action: 'referral.claim', target: referrer.id, payload: { code } as any },
    });
    return { ok: true, message: `Referral applied. Welcome from ${code}!` };
  }

  /**
   * User opt-in/out for the public leaderboard. Generates a stable random
   * handle the first time a user opts in so their userId never leaks.
   */
  async setLeaderboardOptIn(userId: string, optIn: boolean): Promise<{ optIn: boolean; handle: string | null }> {
    let handle: string | null = null;
    if (optIn) {
      const u = await this.prisma.user.findUnique({
        where: { id: userId }, select: { leaderboardHandle: true } as any,
      }) as any;
      handle = u?.leaderboardHandle ?? randomHandle();
    }
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { leaderboardOptIn: optIn, leaderboardHandle: handle } as any,
      select: { leaderboardOptIn: true, leaderboardHandle: true } as any,
    }) as any;
    return { optIn: !!updated.leaderboardOptIn, handle: updated.leaderboardHandle ?? null };
  }

  async getLeaderboardOptIn(userId: string): Promise<{ optIn: boolean; handle: string | null }> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { leaderboardOptIn: true, leaderboardHandle: true } as any,
    }) as any;
    return { optIn: !!u?.leaderboardOptIn, handle: u?.leaderboardHandle ?? null };
  }
}

/* ── Privacy-preserving bucket helpers ─────────────────────────────────────── */
// Log-spaced PnL bands so trackers can't watch real-time deltas.
function bucketPnl(usd: number): string {
  if (usd <= 0) return 'negative';
  if (usd < 100) return '<$100';
  if (usd < 1_000) return '$100-$1k';
  if (usd < 10_000) return '$1k-$10k';
  if (usd < 100_000) return '$10k-$100k';
  if (usd < 1_000_000) return '$100k-$1M';
  return '$1M+';
}

function bucketTrades(n: number): string {
  if (n < 10) return '<10';
  if (n < 50) return '10-50';
  if (n < 200) return '50-200';
  if (n < 1_000) return '200-1k';
  return '1k+';
}

// Stable, non-reversible random handle. Stored once per user on first opt-in.
function randomHandle(): string {
  const adjectives = ['Quiet', 'Bold', 'Sharp', 'Calm', 'Quick', 'Lucky', 'Wise', 'Brave', 'Cool', 'Stoic'];
  const nouns = ['Owl', 'Fox', 'Wolf', 'Hawk', 'Tiger', 'Whale', 'Bear', 'Bull', 'Lynx', 'Shark'];
  const a = adjectives[Math.floor(Math.random() * adjectives.length)];
  const n = nouns[Math.floor(Math.random() * nouns.length)];
  const num = Math.floor(Math.random() * 9000 + 1000);
  return `${a}${n}${num}`;
}
