import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage, NewMessageEvent } from 'telegram/events';
import { Api } from 'telegram/tl';
import { Logger as TgLogger, LogLevel } from 'telegram/extensions/Logger';
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
}

export interface TgGroupDto {
  id: string;
  title: string;
  isChannel: boolean;
  members: number | null;
  lastMessage: { text: string; ts: number } | null;
}

/**
 * Manages one TelegramClient (MTProto/gramjs) per user.
 * Reconnects all active sessions on module init.
 *
 * Message routing:
 *  - NewMessage → emits `tg_message` WS event for every message (all groups)
 *  - NewMessage → SnipeGroupService.handleGroupMessage() for CA extraction + snipe
 */
@Injectable()
export class TgUserbotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TgUserbotService.name);
  private clients = new Map<string, TelegramClient>();
  private reconnecting = new Set<string>(); // prevents duplicate on-demand reconnects

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
    // Await all reconnects so the HTTP server starts with sessions already live.
    // allSettled means one failure doesn't block the others.
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
    const client = this.clients.get(userId);
    if (client) {
      try { await client.invoke(new Api.auth.LogOut()); } catch {}
      try { await client.disconnect(); } catch {}
      this.clients.delete(userId);
    }
    await this.prisma.tgUserSession.updateMany({ where: { userId }, data: { isActive: false } });
    this.ws?.emitToUser(userId, 'tg_status', { connected: false, me: null });
    this.logger.log(`Userbot disconnected: userId=${userId}`);
  }

  isConnected(userId: string): boolean {
    const c = this.clients.get(userId);
    return !!c && !!c.connected;
  }

  /**
   * If the gramjs client is missing but the DB says there's an active session,
   * kick off a background reconnect and return false (frontend will get tg_status
   * via WS when the reconnect completes).
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

    return false; // still false — WS will push the update when done
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
      // dialog.id uses Bot API format: -100<channelId> for channels/supergroups, -<chatId> for regular groups.
      // onNewMessage emits the raw positive channelId/chatId. Normalize here so frontend Map keys match.
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

    // gramjs caches entities from getDialogs calls; passing BigInt lets it resolve from cache.
    // Fall back to re-fetching dialogs if the entity isn't cached yet.
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

    return msgs
      .filter((m: any) => m.message || m.text)
      .map((m: any) => ({
        id: m.id,
        text: m.message ?? m.text ?? '',
        ts: (m.date ?? 0) * 1000,
        fromId: String(m.fromId?.userId ?? m.fromId?.channelId ?? ''),
      }))
      .reverse(); // oldest first (chronological)
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
    // Notify the frontend that the session is live (in case the page was already loaded
    // while the reconnect was still in progress — status would have returned false).
    const me = await this.getMe(userId);
    this.ws?.emitToUser(userId, 'tg_status', { connected: true, me });
    await this.prisma.tgUserSession.updateMany({
      where: { userId },
      data: { lastConnectedAt: new Date() },
    });
  }

  private async startClient(userId: string, sessionString: string): Promise<void> {
    const existing = this.clients.get(userId);
    if (existing) { try { await existing.disconnect(); } catch {} }

    const session = new StringSession(sessionString);
    const client = new TelegramClient(session, TG_API_ID, TG_API_HASH, {
      connectionRetries: 5,
      retryDelay: 1000,
      autoReconnect: true,
      baseLogger: new TgLogger(LogLevel.NONE),
    });

    await client.connect();
    this.clients.set(userId, client);

    client.addEventHandler(
      (event: NewMessageEvent) => this.onNewMessage(userId, event).catch(() => {}),
      new NewMessage({}),
    );

    this.logger.log(`Userbot connected: userId=${userId}`);
  }

  private async onNewMessage(userId: string, event: NewMessageEvent): Promise<void> {
    const msg = event.message;
    const text = (msg as any).text ?? (msg as any).message ?? '';
    if (!text) return;

    const peer = (msg as any).peerId;
    let rawId: string | null = null;
    if (peer instanceof Api.PeerChannel) rawId = String(peer.channelId);
    else if (peer instanceof Api.PeerChat)  rawId = String(peer.chatId);
    if (!rawId) return; // skip DMs

    // Emit to user's Telegram inbox view for EVERY incoming message (all groups)
    this.logger.debug(`tg_message: userId=${userId} groupId=${rawId} ws=${!!this.ws}`);
    this.ws?.emitToUser(userId, 'tg_message', {
      groupId: rawId,
      text: text.slice(0, 1000),
      ts: Date.now(),
      messageId: (msg as any).id,
      fromId: String((msg as any).fromId?.userId ?? ''),
    });

    // Route to snipe handler for CA extraction + buy logic
    await this.snipeGroup.handleGroupMessage(rawId, text, userId);
  }
}
