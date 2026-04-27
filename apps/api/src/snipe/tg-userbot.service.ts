import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
import { NewMessage, NewMessageEvent } from 'teleproto/events';
import { Api } from 'teleproto/tl';
import { Logger as TgLogger, LogLevel } from 'teleproto/extensions/Logger';
import { KmsService } from '../wallets/kms.service';
import { PrismaService } from '../prisma/prisma.service';
import { SnipeGroupService } from './snipe-group.service';
import { RealtimeGateway } from '../ws/realtime.gateway';

const TG_API_ID  = parseInt(process.env.TELEGRAM_API_ID  ?? '0', 10);
const TG_API_HASH = process.env.TELEGRAM_API_HASH ?? '';

export interface TgMessageDto {
  id: number;
  text: string;
  ts: number;
  fromId: string;
  senderName?: string;
}

export interface TgGroupDto {
  id: string;
  title: string;
  isChannel: boolean;
  members: number | null;
  lastMessage: { text: string; ts: number } | null;
}

/**
 * Manages one TelegramClient (teleproto/MTProto) per user.
 * Reconnects all active sessions on module init.
 *
 * Message routing:
 *  - NewMessage → emits `tg_message` WS event for every message (all groups)
 *  - NewMessage → SnipeGroupService.handleGroupMessage() for CA extraction + snipe
 */
@Injectable()
export class TgUserbotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TgUserbotService.name);
  private clients      = new Map<string, TelegramClient>();
  private reconnecting = new Set<string>();
  private keepAlives   = new Map<string, ReturnType<typeof setInterval>>();
  private lastUpdate   = new Map<string, number>(); // userId → timestamp of last received message

  constructor(
    private prisma: PrismaService,
    private kms: KmsService,
    private snipeGroup: SnipeGroupService,
    @Optional() private ws: RealtimeGateway,
  ) {}

  async onModuleInit() {
    if (!TG_API_ID || !TG_API_HASH) {
      this.logger.warn('TELEGRAM_API_ID / TELEGRAM_API_HASH not set — userbot disabled');
      return;
    }
    const sessions = await this.prisma.tgUserSession.findMany({ where: { isActive: true } });
    this.logger.log(`Reconnecting ${sessions.length} Telegram userbot sessions…`);
    await Promise.allSettled(
      sessions.map((row) =>
        this.reconnect(row.userId, row.encryptedSession, row.encryptedDek).catch((e) =>
          this.logger.warn(`Failed to reconnect userId=${row.userId}: ${e.message}`),
        ),
      ),
    );
    this.logger.log(`Telegram sessions ready.`);
  }

  async onModuleDestroy() {
    for (const [userId, iv] of this.keepAlives) {
      clearInterval(iv);
      this.logger.debug(`Cleared keepAlive: userId=${userId}`);
    }
    this.keepAlives.clear();
    for (const [userId, client] of this.clients) {
      try { await client.disconnect(); } catch {}
      this.logger.debug(`Disconnected userbot: userId=${userId}`);
    }
    this.clients.clear();
  }

  /** Connect a user with a fresh session string (called from TgAuthService after login). */
  async connect(userId: string, sessionString: string): Promise<void> {
    await this.startClient(userId, sessionString);
    try {
      const { ciphertext, encryptedDek } = await this.kms.encrypt(Buffer.from(sessionString, 'utf8'));
      const phone = (await this.clients.get(userId)?.getMe() as any)?.phone ?? '';
      await this.prisma.tgUserSession.upsert({
        where: { userId },
        update: { encryptedSession: ciphertext, encryptedDek, isActive: true, lastConnectedAt: new Date(), phoneNumber: phone },
        create: { userId, encryptedSession: ciphertext, encryptedDek, isActive: true, lastConnectedAt: new Date(), phoneNumber: phone },
      });
      this.logger.log(`Session persisted for userId=${userId} phone=${phone}`);
    } catch (e: any) {
      this.logger.error(`Failed to persist TG session for userId=${userId}: ${e.message}`);
    }
    this.ws?.emitToUser(userId, 'tg_status', { connected: true, me: await this.getMe(userId) });
  }

  async disconnect(userId: string): Promise<void> {
    this.stopKeepAlive(userId);
    const client = this.clients.get(userId);
    if (client) {
      try { await client.invoke(new Api.auth.LogOut()); } catch {}
      try { await client.disconnect(); } catch {}
      this.clients.delete(userId);
    }
    this.lastUpdate.delete(userId);
    await this.prisma.tgUserSession.updateMany({ where: { userId }, data: { isActive: false } });
    this.ws?.emitToUser(userId, 'tg_status', { connected: false, me: null });
    this.logger.log(`Userbot disconnected: userId=${userId}`);
  }

  isConnected(userId: string): boolean {
    const c = this.clients.get(userId);
    return !!c && !!c.connected;
  }

  /**
   * If the client is missing but DB has an active session, kick off a background
   * reconnect and return false — frontend gets tg_status via WS when done.
   */
  async ensureConnected(userId: string): Promise<boolean> {
    if (this.isConnected(userId)) return true;
    if (this.reconnecting.has(userId)) return false;

    const row = await this.prisma.tgUserSession.findUnique({
      where: { userId },
      select: { encryptedSession: true, encryptedDek: true, isActive: true },
    });
    if (!row?.isActive) return false;

    this.reconnecting.add(userId);
    this.reconnect(userId, row.encryptedSession, row.encryptedDek)
      .catch((e) => this.logger.warn(`On-demand reconnect failed userId=${userId}: ${e.message}`))
      .finally(() => this.reconnecting.delete(userId));

    return false;
  }

  getClient(userId: string): TelegramClient | undefined {
    return this.clients.get(userId);
  }

  /** List all groups + channels the user is a member of, with last message preview. */
  async getGroups(userId: string): Promise<TgGroupDto[]> {
    const client = this.clients.get(userId);
    if (!client || !client.connected) throw new Error('Not connected');

    const dialogs = await client.getDialogs({ limit: 500 });
    const groups: TgGroupDto[] = [];
    for (const dialog of dialogs) {
      if (!dialog.isGroup && !dialog.isChannel) continue;
      const entity = dialog.entity as any;
      const lastMsg = dialog.message as any;
      // Normalize Bot-API signed IDs to raw positive IDs (matches snipeConfig.groupIds)
      const rawId = String(dialog.id ?? 0);
      const normId = rawId.startsWith('-100') ? rawId.slice(4)
                   : rawId.startsWith('-')   ? rawId.slice(1)
                   : rawId;
      groups.push({
        id: normId,
        title: dialog.title ?? '',
        isChannel: !!dialog.isChannel,
        members: entity?.participantsCount ?? null,
        lastMessage: lastMsg ? {
          text: (lastMsg.message ?? lastMsg.text ?? '').slice(0, 80),
          ts: (lastMsg.date ?? 0) * 1000,
        } : null,
      });
    }
    return groups;
  }

  /** Fetch recent message history for a specific group/channel. */
  async getGroupMessages(userId: string, groupId: string, limit = 50): Promise<TgMessageDto[]> {
    const client = this.clients.get(userId);
    if (!client || !client.connected) throw new Error('Not connected');

    const bigId = BigInt(groupId);
    let msgs: any[] = [];

    try {
      msgs = await client.getMessages(bigId as any, { limit });
    } catch {
      try {
        await client.getDialogs({ limit: 500 });
        msgs = await client.getMessages(bigId as any, { limit });
      } catch (e2: any) {
        throw new Error(`Cannot fetch messages for group ${groupId}: ${e2.message}`);
      }
    }

    const filtered = msgs.filter((m: any) => m.message || m.text);

    const senderCache = new Map<string, string>();
    const result: TgMessageDto[] = [];
    for (const m of filtered) {
      const fromIdStr = String(m.fromId?.userId ?? m.fromId?.channelId ?? '');
      let senderName = senderCache.get(fromIdStr);
      if (senderName === undefined && fromIdStr) {
        try {
          const sender: any = await m.getSender();
          if (sender) {
            senderName = sender.firstName
              ? [sender.firstName, sender.lastName].filter(Boolean).join(' ')
              : sender.title ?? sender.username ?? '';
          } else {
            senderName = '';
          }
        } catch { senderName = ''; }
        senderCache.set(fromIdStr, senderName ?? '');
      }
      result.push({
        id: m.id,
        text: m.message ?? m.text ?? '',
        ts: (m.date ?? 0) * 1000,
        fromId: fromIdStr,
        senderName: senderName || undefined,
      });
    }
    return result.reverse(); // oldest first
  }

  async getMe(userId: string): Promise<{ phone: string; username: string | null; firstName: string } | null> {
    const client = this.clients.get(userId);
    if (!client || !client.connected) return null;
    const me = await client.getMe() as any;
    return {
      phone: me.phone ?? '',
      username: me.username ?? null,
      firstName: me.firstName ?? '',
    };
  }

  // ── Private ──

  private async reconnect(userId: string, encCiphertext: string, encDek: string): Promise<void> {
    const raw = await this.kms.decrypt({ ciphertext: encCiphertext, encryptedDek: encDek });
    const sessionString = raw.toString('utf8');
    await this.startClient(userId, sessionString);
    const me = await this.getMe(userId);
    this.ws?.emitToUser(userId, 'tg_status', { connected: true, me });
    await this.prisma.tgUserSession.updateMany({
      where: { userId },
      data: { lastConnectedAt: new Date() },
    });
  }

  private async startClient(userId: string, sessionString: string): Promise<void> {
    this.stopKeepAlive(userId);
    const existing = this.clients.get(userId);
    if (existing) { try { await existing.disconnect(); } catch {} }

    const session = new StringSession(sessionString);
    const client = new TelegramClient(session, TG_API_ID, TG_API_HASH, {
      connectionRetries: 10,
      retryDelay: 2000,
      autoReconnect: true,
      baseLogger: new TgLogger(LogLevel.WARN),
    });

    await client.connect();
    this.clients.set(userId, client);
    this.lastUpdate.set(userId, Date.now());

    client.addEventHandler(
      (event: NewMessageEvent) => this.onNewMessage(userId, event).catch(() => {}),
      new NewMessage({}),
    );

    this.logger.log(`Userbot connected: userId=${userId}`);
    this.startKeepAlive(userId, sessionString);
  }

  // ── KeepAlive — detects stalled update loop and force-reconnects ──────────

  private startKeepAlive(userId: string, sessionString: string): void {
    const iv = setInterval(async () => {
      const client = this.clients.get(userId);
      const stale = Date.now() - (this.lastUpdate.get(userId) ?? 0) > 3 * 60_000;

      if (!client || !client.connected || stale) {
        this.logger.warn(`KeepAlive: reconnecting userId=${userId} (connected=${client?.connected}, stale=${stale})`);
        try {
          await this.startClient(userId, sessionString);
          const me = await this.getMe(userId);
          this.ws?.emitToUser(userId, 'tg_status', { connected: true, me });
        } catch (e: any) {
          this.logger.warn(`KeepAlive reconnect failed userId=${userId}: ${e.message}`);
        }
      }
    }, 90_000);

    this.keepAlives.set(userId, iv);
  }

  private stopKeepAlive(userId: string): void {
    const iv = this.keepAlives.get(userId);
    if (iv) { clearInterval(iv); this.keepAlives.delete(userId); }
  }

  private async onNewMessage(userId: string, event: NewMessageEvent): Promise<void> {
    this.lastUpdate.set(userId, Date.now());
    const msg = event.message;
    const text = (msg as any).text ?? (msg as any).message ?? '';
    if (!text) return;

    const peer = (msg as any).peerId;
    let rawId: string | null = null;
    if (peer instanceof Api.PeerChannel) rawId = String(peer.channelId);
    else if (peer instanceof Api.PeerChat)  rawId = String(peer.chatId);
    if (!rawId) return; // skip DMs

    this.logger.debug(`tg_message: userId=${userId} groupId=${rawId} ws=${!!this.ws}`);
    let senderName = '';
    try {
      const sender: any = await event.message.getSender();
      if (sender) {
        senderName = sender.firstName
          ? [sender.firstName, sender.lastName].filter(Boolean).join(' ')
          : sender.title ?? sender.username ?? '';
      }
    } catch {}

    this.ws?.emitToUser(userId, 'tg_message', {
      groupId: rawId,
      text: text.slice(0, 1000),
      ts: Date.now(),
      messageId: (msg as any).id,
      fromId: String((msg as any).fromId?.userId ?? ''),
      senderName,
    });

    await this.snipeGroup.handleGroupMessage(rawId, text, userId);
  }
}
