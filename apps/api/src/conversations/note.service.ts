import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { NoteCategory, NoteStatus, Prisma, UserNote } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface NoteProposal {
  category: NoteCategory;
  content: string;
  confidence: number;
  sourceConversationId: string;
}

@Injectable()
export class NoteService {
  private readonly logger = new Logger(NoteService.name);

  constructor(private prisma: PrismaService) {}

  async list(userId: string, opts?: { category?: NoteCategory; status?: NoteStatus }) {
    return this.prisma.userNote.findMany({
      where: { userId, ...(opts?.category ? { category: opts.category } : {}), status: opts?.status ?? NoteStatus.ACTIVE },
      orderBy: { lastConfirmedAt: 'desc' },
    });
  }

  async topForUser(userId: string, limit: number): Promise<UserNote[]> {
    return this.prisma.userNote.findMany({
      where: { userId, status: NoteStatus.ACTIVE },
      orderBy: [{ confidence: 'desc' }, { lastConfirmedAt: 'desc' }],
      take: limit,
    });
  }

  async createManual(userId: string, data: { category: NoteCategory; content: string }) {
    return this.prisma.userNote.create({
      data: {
        userId,
        category: data.category,
        content: data.content.slice(0, 400),
        sourceConversationIds: [],
        confidence: 1.0,
      },
    });
  }

  async proposeFromExtraction(userId: string, proposal: NoteProposal): Promise<UserNote> {
    const norm = normalize(proposal.content);
    const existing = await this.prisma.userNote.findMany({
      where: { userId, status: NoteStatus.ACTIVE, category: proposal.category },
      take: 50,
    });
    for (const ex of existing) {
      if (jaccardOverlap(norm, normalize(ex.content)) >= 0.6) {
        const sourceIds = Array.from(new Set([...ex.sourceConversationIds, proposal.sourceConversationId]));
        return this.prisma.userNote.update({
          where: { id: ex.id },
          data: {
            confirmCount: { increment: 1 },
            lastConfirmedAt: new Date(),
            confidence: Math.max(ex.confidence, proposal.confidence),
            sourceConversationIds: sourceIds,
          },
        });
      }
    }
    return this.prisma.userNote.create({
      data: {
        userId,
        category: proposal.category,
        content: proposal.content.slice(0, 400),
        sourceConversationIds: [proposal.sourceConversationId],
        confidence: Math.max(0, Math.min(1, proposal.confidence)),
      },
    });
  }

  async retire(userId: string, id: string, reason = 'user') {
    const n = await this.prisma.userNote.findUnique({ where: { id } });
    if (!n || n.userId !== userId) throw new NotFoundException();
    return this.prisma.userNote.update({
      where: { id },
      data: { status: NoteStatus.RETIRED, retiredAt: new Date(), retiredReason: reason },
    });
  }

  async retireMatching(userId: string, query: string): Promise<number> {
    const norm = normalize(query);
    if (!norm) return 0;
    const active = await this.prisma.userNote.findMany({ where: { userId, status: NoteStatus.ACTIVE } });
    const ids = active.filter((n) => jaccardOverlap(norm, normalize(n.content)) >= 0.4).map((n) => n.id);
    if (!ids.length) return 0;
    await this.prisma.userNote.updateMany({
      where: { id: { in: ids } },
      data: { status: NoteStatus.RETIRED, retiredAt: new Date(), retiredReason: 'user-forget' },
    });
    return ids.length;
  }

  async retireStale(): Promise<number> {
    const cutoff = new Date(Date.now() - 90 * 24 * 3600_000);
    const avoidCutoff = new Date(Date.now() - 365 * 24 * 3600_000);
    const result = await this.prisma.userNote.updateMany({
      where: {
        status: NoteStatus.ACTIVE,
        OR: [
          { category: { not: 'AVOIDANCE' }, lastConfirmedAt: { lt: cutoff }, confidence: { lt: 0.85 } },
          { category: 'AVOIDANCE', lastConfirmedAt: { lt: avoidCutoff }, confidence: { lt: 0.85 } },
        ],
      } as unknown as Prisma.UserNoteWhereInput,
      data: { status: NoteStatus.RETIRED, retiredAt: new Date(), retiredReason: 'stale' },
    });
    return result.count;
  }
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2)
    .join(' ');
}

function jaccardOverlap(a: string, b: string): number {
  if (!a || !b) return 0;
  const at = new Set(a.split(' '));
  const bt = new Set(b.split(' '));
  let inter = 0;
  for (const t of at) if (bt.has(t)) inter++;
  const union = at.size + bt.size - inter;
  return union === 0 ? 0 : inter / union;
}
