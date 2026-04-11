import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Unified session: web user generates a one-time code, sends `/link <code>` from Telegram,
 * which writes a row mapping telegramId → userId. After that, the same conversation memory is shared.
 */
@Injectable()
export class TelegramLinkService {
  constructor(private prisma: PrismaService) {}
  private codes = new Map<string, { userId: string; expires: number }>();

  issueCode(userId: string): string {
    const code = randomBytes(4).toString('hex');
    this.codes.set(code, { userId, expires: Date.now() + 5 * 60_000 });
    return code;
  }

  async link(telegramId: string, code: string): Promise<{ userId: string } | null> {
    const entry = this.codes.get(code);
    if (!entry || entry.expires < Date.now()) return null;
    this.codes.delete(code);
    await this.prisma.auditLog.create({
      data: { userId: entry.userId, action: 'telegram.link', target: telegramId },
    });
    // Persist mapping in conversationMessage meta or a dedicated table — for MVP we use audit + meta
    return { userId: entry.userId };
  }
}
