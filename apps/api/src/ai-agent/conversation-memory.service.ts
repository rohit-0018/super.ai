import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ConversationMemoryService {
  constructor(private prisma: PrismaService) {}

  async append(userId: string, role: 'user' | 'assistant', content: string, channel: 'web' | 'telegram') {
    return this.prisma.conversationMessage.create({ data: { userId, role, content, channel } });
  }

  async recent(userId: string, limit = 20) {
    const rows = await this.prisma.conversationMessage.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.reverse().map((r) => ({
      role: r.role as 'user' | 'assistant',
      content: r.content,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}
