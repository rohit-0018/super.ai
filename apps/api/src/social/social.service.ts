import { Injectable } from '@nestjs/common';
import { AgentKind, AgentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SocialService {
  constructor(private prisma: PrismaService) {}

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
    const enriched = await Promise.all(
      rows.map(async (r, i) => {
        const wins = await this.prisma.trade.count({
          where: { userId: r.userId, createdAt: { gte: since }, pnlUsd: { gt: 0 } },
        });
        return {
          rank: i + 1,
          anonId: 'qwai-' + r.userId.slice(0, 6),
          pnlUsd: r._sum.pnlUsd ?? 0,
          trades: r._count,
          winRate: r._count > 0 ? wins / r._count : 0,
        };
      }),
    );
    return enriched;
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

  async signalFeed(limit = 20) {
    return this.prisma.alertEvent.findMany({
      where: { kind: 'SIGNAL_CARD' },
      orderBy: { createdAt: 'desc' },
      take: limit,
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
}
