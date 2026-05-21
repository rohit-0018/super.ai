import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { makeQueue, QUEUES } from '../agents/queues';
import { SnipeSessionService, CachedSnipeConfig } from './snipe-session.service';
import { SnipeFastService } from './snipe-fast.service';
import { ParallelSnipeService } from './parallel-snipe.service';
import { extractAddresses, matchesPattern } from './address-extractor';
import { RealtimeGateway } from '../ws/realtime.gateway';

/**
 * Routes inbound Telegram group/channel messages to the sniping loop.
 *
 * Called by two sources:
 *  1. Grammy bot handler (bot-in-group path) — groupId is Bot API format (may have -100 prefix)
 *  2. TgUserbotService (MTProto/gramjs path) — groupId is raw positive bigint string
 *
 * `tg_message` WS events are emitted by TgUserbotService for all messages.
 * This service only handles CA extraction + buy execution.
 */
@Injectable()
export class SnipeGroupService {
  private readonly logger = new Logger(SnipeGroupService.name);
  private tgSendQueue = makeQueue(QUEUES.TELEGRAM_SEND);
  private chatIdCache = new Map<string, { chatId: string | null; ts: number }>();

  constructor(
    private prisma: PrismaService,
    private snipeSession: SnipeSessionService,
    private snipeFast: SnipeFastService,
    private parallelSnipe: ParallelSnipeService,
    @Optional() private ws: RealtimeGateway,
  ) {}

  public stopUserSession(userId: string) { this.snipeSession.stopSession(userId); }
  public getUserSessionStatus(userId: string) { return this.snipeSession.sessionStatus(userId); }

  /**
   * Main entry point — called from Grammy handler or TgUserbotService.
   * @param groupId raw chat ID (any format: "-1001234", "1001234", "1234")
   * @param text    message text
   * @param forUserId when provided, only process configs for this user (MTProto path)
   */
  async handleGroupMessage(groupId: string, text: string, forUserId?: string): Promise<void> {
    const normId = normalizeGroupId(groupId);

    let configs: CachedSnipeConfig[];
    if (forUserId) {
      configs = await this.snipeSession.getConfigsForGroup(normId);
      configs = configs.filter((c) => c.userId === forUserId);
    } else {
      configs = await this.snipeSession.getConfigsForGroup(normId);
    }

    if (configs.length === 0) return;

    const tasks: Promise<void>[] = [];
    for (const config of configs) {
      // Apply match pattern — skip message if it doesn't pass the filter
      if (!matchesPattern(text, config.matchPattern)) continue;

      const addresses = extractAddresses(text, config.chain);
      if (addresses.length === 0) continue;

      // Either a primary hot session OR an armed burst session set is enough
      // to fire. Burst mode takes precedence when armed — see snipeOne.
      const hasBurst = this.snipeSession.getBurstSessions(config.userId).length > 0;
      if (!hasBurst && !this.snipeSession.hasActiveSession(config.userId)) {
        this.logger.debug(`No hot session user=${config.userId} — skipping`);
        this.ws?.emitToUser(config.userId, 'snipe_skipped', { reason: 'no_session', groupId: normId, ts: Date.now() });
        continue;
      }

      for (const addr of addresses) {
        if (this.snipeSession.isDuplicate(config.userId, addr, config.dedupeWindowMs)) continue;
        tasks.push(this.snipeOne(config, addr, normId, text));
      }
    }

    if (tasks.length > 0) await Promise.all(tasks);
  }

  private async snipeOne(
    config: CachedSnipeConfig,
    mint: string,
    groupId: string,
    text: string,
  ): Promise<void> {
    // When burst sessions are armed for this user, the TG-received address
    // gets fan-out-fired across every armed Solana wallet instead of the
    // single configured one. Amount + slippage come from SnipeConfig so the
    // existing /snipe tuning still applies per-wallet.
    const burstSessions = this.snipeSession.getBurstSessions(config.userId);
    if (burstSessions.length > 0) {
      return this.snipeBurst(config, mint, groupId, burstSessions.length);
    }

    const result = await this.snipeFast.execute(config, mint, groupId, text);
    if (!config.notifyOnBuy) return;

    const tgChatId = await this.resolveTgChatId(config.userId);
    if (!tgChatId) return;

    const solscanUrl = result.txHash ? `https://solscan.io/tx/${result.txHash}` : null;
    const msgText = result.txHash
      ? [
          `⚡ *Sniped!*`,
          `Mint: \`${mint}\``,
          `Amount: ${(Number(config.buyAmountRaw) / 1e9).toFixed(4)} SOL`,
          `Latency: ${result.durationMs}ms`,
          solscanUrl ? `[View tx](${solscanUrl})` : `Sig: \`${result.txHash?.slice(0, 16)}...\``,
        ].join('\n')
      : `❌ Snipe failed for \`${mint.slice(0, 12)}...\` (${result.durationMs}ms)`;

    await this.tgSendQueue.add('send', {
      chatId: tgChatId,
      text: msgText,
      opts: { parseMode: 'Markdown', disableWebPagePreview: true },
    }, { attempts: 2, removeOnComplete: 50, removeOnFail: 50 });
  }

  /**
   * Burst-mode TG snipe: fan out across every armed wallet for this user.
   * Emits a single rolled-up TG notification (not one per wallet) so the
   * user sees "5/5 fired" rather than five separate "Sniped!" messages.
   */
  private async snipeBurst(
    config: CachedSnipeConfig,
    mint: string,
    groupId: string,
    walletCount: number,
  ): Promise<void> {
    this.logger.log(
      `TG → burst: user=${config.userId} mint=${mint.slice(0, 8)}… wallets=${walletCount} group=${groupId}`,
    );
    let summary: { fired: number; results: { txHash: string | null; address: string }[]; durationMs: number };
    try {
      const r = await this.parallelSnipe.burst({
        userId: config.userId,
        mint,
        buyAmountRaw: config.buyAmountRaw,
        maxSlippageBps: config.maxSlippageBps,
        pauseWorkers: true,
      });
      summary = { fired: r.fired, results: r.results, durationMs: r.durationMs };
    } catch (e: any) {
      this.logger.error(`TG burst failed user=${config.userId}: ${e?.message}`);
      return;
    }

    if (!config.notifyOnBuy) return;
    const tgChatId = await this.resolveTgChatId(config.userId);
    if (!tgChatId) return;

    const total = summary.results.length;
    const perWalletSol = (Number(config.buyAmountRaw) / 1e9).toFixed(4);
    const firstHash = summary.results.find((r) => r.txHash)?.txHash ?? null;
    const msgText = summary.fired > 0
      ? [
          `⚡ *Burst sniped!*`,
          `Mint: \`${mint}\``,
          `Fired: *${summary.fired}/${total}* wallets · ${perWalletSol} SOL each`,
          `Latency: ${summary.durationMs}ms`,
          firstHash ? `[First tx](https://solscan.io/tx/${firstHash})` : '',
        ].filter(Boolean).join('\n')
      : `❌ Burst snipe failed across all ${total} wallets for \`${mint.slice(0, 12)}…\``;

    await this.tgSendQueue.add('send', {
      chatId: tgChatId,
      text: msgText,
      opts: { parseMode: 'Markdown', disableWebPagePreview: true },
    }, { attempts: 2, removeOnComplete: 50, removeOnFail: 50 });
  }

  private async resolveTgChatId(userId: string): Promise<string | null> {
    const cached = this.chatIdCache.get(userId);
    if (cached && Date.now() - cached.ts < 120_000) return cached.chatId;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { telegramChatId: true },
    });
    const chatId = user?.telegramChatId ?? null;
    this.chatIdCache.set(userId, { chatId, ts: Date.now() });
    return chatId;
  }
}

/**
 * Normalize Telegram chat IDs to a plain positive string so both sources match.
 *   Bot API:  "-1001234567890"  →  "1234567890"
 *   Bot API:  "-123456"         →  "123456"
 *   gramjs:   "1234567890"      →  "1234567890"  (no change)
 */
export function normalizeGroupId(id: string): string {
  if (id.startsWith('-100')) return id.slice(4);
  if (id.startsWith('-'))   return id.slice(1);
  return id;
}
