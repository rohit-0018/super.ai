import { Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Unified session linking web ↔ Telegram in both directions:
 *  Web→TG:  user calls POST /auth/telegram/code, sends `/link <code>` in bot.
 *  TG→Web:  user sends /login in bot, bot issues a magic link; user taps it on the web.
 */
@Injectable()
export class TelegramLinkService {
  constructor(private prisma: PrismaService) {}

  // Web-initiated codes (upper-hex, 10 min)
  private codes = new Map<string, { userId: string; expires: number }>();

  // Bot-initiated magic-link tokens (lower-hex, 10 min) — maps token → chatId
  private magicTokens = new Map<string, { chatId: string; expires: number }>();

  /* ─── Web → TG flow ──────────────────────────────────────────────────────── */

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

  /* ─── TG → Web magic-link flow ───────────────────────────────────────────── */

  issueMagicToken(telegramChatId: string): { token: string; expiresAt: Date } {
    const token = randomBytes(5).toString('hex'); // 10-char hex
    const expires = Date.now() + 10 * 60_000;
    this.magicTokens.set(token, { chatId: telegramChatId, expires });
    return { token, expiresAt: new Date(expires) };
  }

  async claimMagicToken(token: string, userId: string): Promise<{ chatId: string }> {
    const entry = this.magicTokens.get(token);
    if (!entry || entry.expires < Date.now()) {
      throw new NotFoundException('Magic link expired or already used');
    }
    this.magicTokens.delete(token);

    await this.prisma.user.update({
      where: { id: userId },
      data: { telegramChatId: entry.chatId },
    });
    await this.prisma.auditLog.create({
      data: { userId, action: 'telegram.magic_link', target: entry.chatId },
    });
    return { chatId: entry.chatId };
  }

  /* ─── Shared ─────────────────────────────────────────────────────────────── */

  async resolveByChatId(telegramChatId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { telegramChatId },
      select: { id: true },
    });
    return user?.id ?? null;
  }
}
