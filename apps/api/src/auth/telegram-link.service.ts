import { Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Unified session: web user generates a one-time code, sends `/link <code>` from Telegram,
 * which persists telegramChatId on the User row. After that, the same AI brain and memory
 * are shared across Web and Telegram.
 */
@Injectable()
export class TelegramLinkService {
  constructor(private prisma: PrismaService) {}
  private codes = new Map<string, { userId: string; expires: number }>();

  issueCode(userId: string): { code: string; expiresAt: Date } {
    const code = randomBytes(4).toString('hex').toUpperCase();
    const expires = Date.now() + 10 * 60_000;
    this.codes.set(code, { userId, expires });
    return { code, expiresAt: new Date(expires) };
  }

  async link(telegramChatId: string, code: string): Promise<{ userId: string }> {
    const entry = this.codes.get(code.toUpperCase());
    if (!entry || entry.expires < Date.now()) {
      throw new NotFoundException('Code expired or unknown');
    }
    this.codes.delete(code.toUpperCase());

    await this.prisma.user.update({
      where: { id: entry.userId },
      data: { telegramChatId },
    });
    await this.prisma.auditLog.create({
      data: { userId: entry.userId, action: 'telegram.link', target: telegramChatId },
    });
    return { userId: entry.userId };
  }

  async resolveByChatId(telegramChatId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { telegramChatId },
      select: { id: true },
    });
    return user?.id ?? null;
  }
}
