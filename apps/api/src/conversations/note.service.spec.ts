import { Test } from '@nestjs/testing';
import { NoteCategory, NoteStatus } from '@prisma/client';
import { NoteService } from './note.service';
import { PrismaService } from '../prisma/prisma.service';

describe('NoteService', () => {
  async function build(prismaMock: Partial<PrismaService>) {
    const mod = await Test.createTestingModule({
      providers: [NoteService, { provide: PrismaService, useValue: prismaMock }],
    }).compile();
    return mod.get(NoteService);
  }

  it('dedupes near-identical notes by bumping confirmCount', async () => {
    const existing = {
      id: 'n1',
      userId: 'u1',
      category: NoteCategory.PREFERENCE,
      content: 'The user prefers Solana for small trades',
      sourceConversationIds: ['c1'],
      confidence: 0.8,
      confirmCount: 1,
      lastConfirmedAt: new Date(),
      status: NoteStatus.ACTIVE,
      retiredAt: null,
      retiredReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const updateMock = jest.fn().mockResolvedValue({ ...existing, confirmCount: 2 });
    const createMock = jest.fn();
    const svc = await build({
      userNote: {
        findMany: jest.fn().mockResolvedValue([existing]),
        update: updateMock,
        create: createMock,
      },
    } as any);

    const out = await svc.proposeFromExtraction('u1', {
      category: NoteCategory.PREFERENCE,
      content: 'User prefers solana small trades',
      confidence: 0.9,
      sourceConversationId: 'c2',
    });
    expect(updateMock).toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
    expect(out.confirmCount).toBe(2);
    const update = updateMock.mock.calls[0][0];
    expect(update.data.sourceConversationIds).toContain('c2');
    expect(update.data.confidence).toBe(0.9);
  });

  it('creates a new note when no dedup match exists', async () => {
    const created = {
      id: 'n2',
      userId: 'u1',
      category: NoteCategory.AVOIDANCE,
      content: 'Got burned on $XYZ — don\'t surface it',
      sourceConversationIds: ['c9'],
      confidence: 0.9,
      confirmCount: 1,
      lastConfirmedAt: new Date(),
      status: NoteStatus.ACTIVE,
      retiredAt: null,
      retiredReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const createMock = jest.fn().mockResolvedValue(created);
    const svc = await build({
      userNote: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
        create: createMock,
      },
    } as any);
    const out = await svc.proposeFromExtraction('u1', {
      category: NoteCategory.AVOIDANCE,
      content: created.content,
      confidence: 0.9,
      sourceConversationId: 'c9',
    });
    expect(createMock).toHaveBeenCalled();
    expect(out.id).toBe('n2');
  });
});
