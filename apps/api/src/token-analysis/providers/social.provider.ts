import { Injectable, Logger } from '@nestjs/common';
import type { SocialData, TokenMeta } from '../token-analysis.types';

/**
 * Extracts and enriches social signals for a token.
 *
 * Free sources:
 *  - DexScreener socials[] / websites[] (already in TokenMeta — zero extra call)
 *  - Telegram Bot API: getChatMembersCount (uses existing bot token)
 *  - RDAP.org: domain registration date for age scoring
 */
@Injectable()
export class SocialProvider {
  private readonly logger = new Logger(SocialProvider.name);
  private readonly botToken: string | null;

  constructor() {
    this.botToken = process.env.TELEGRAM_BOT_TOKEN ?? null;
  }

  async getData(meta: TokenMeta): Promise<SocialData> {
    const socials  = meta.socials  ?? [];
    const websites = meta.websites ?? [];

    const twitterEntry  = socials.find((s) => s.type === 'twitter');
    const telegramEntry = socials.find((s) => s.type === 'telegram');
    const websiteEntry  = websites[0];

    const twitterUrl  = twitterEntry?.url;
    const telegramUrl = telegramEntry?.url;
    const websiteUrl  = websiteEntry?.url;

    const hasSocials = !!(twitterUrl || telegramUrl || websiteUrl);

    // Parallel enrichment — each fails gracefully
    const [telegramMembers, domainAgeDays] = await Promise.all([
      this.getTelegramMembers(telegramUrl),
      this.getDomainAge(websiteUrl),
    ]);

    return { twitterUrl, telegramUrl, websiteUrl, telegramMembers, domainAgeDays, hasSocials };
  }

  private async getTelegramMembers(url?: string): Promise<number | undefined> {
    if (!url || !this.botToken) return undefined;
    try {
      const username = this.extractTelegramUsername(url);
      if (!username) return undefined;
      const res = await fetch(
        `https://api.telegram.org/bot${this.botToken}/getChatMembersCount?chat_id=@${username}`,
        { signal: AbortSignal.timeout(4_000) },
      );
      if (!res.ok) return undefined;
      const body = await res.json();
      return body?.ok && typeof body.result === 'number' ? body.result : undefined;
    } catch {
      return undefined;
    }
  }

  private async getDomainAge(url?: string): Promise<number | undefined> {
    if (!url) return undefined;
    try {
      const hostname = new URL(url).hostname.replace(/^www\./, '');
      // RDAP.org: public WHOIS-over-HTTP, no auth required
      const res = await fetch(`https://rdap.org/domain/${hostname}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(4_000),
      });
      if (!res.ok) return undefined;
      const body = await res.json();
      const events: Array<{ eventAction: string; eventDate: string }> = body?.events ?? [];
      const reg = events.find((e) => e.eventAction === 'registration');
      if (!reg?.eventDate) return undefined;
      const regMs = new Date(reg.eventDate).getTime();
      if (!Number.isFinite(regMs)) return undefined;
      return Math.floor((Date.now() - regMs) / 86_400_000); // ms → days
    } catch {
      return undefined;
    }
  }

  private extractTelegramUsername(url: string): string | null {
    try {
      const u = new URL(url);
      // https://t.me/username or https://telegram.me/username
      const path = u.pathname.replace(/^\/+/, '');
      const username = path.split('/')[0];
      return username && /^[a-zA-Z0-9_]{5,}$/.test(username) ? username : null;
    } catch {
      return null;
    }
  }
}
