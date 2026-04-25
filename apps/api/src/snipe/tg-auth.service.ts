import { Injectable, Logger } from '@nestjs/common';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Api } from 'telegram/tl';
import { computeCheck } from 'telegram/Password';
import { Logger as TgLogger, LogLevel } from 'telegram/extensions/Logger';
import { TgUserbotService } from './tg-userbot.service';

function silentTgLogger() {
  const l = new TgLogger(LogLevel.NONE);
  return l;
}

const TG_API_ID  = parseInt(process.env.TELEGRAM_API_ID  ?? '0', 10);
const TG_API_HASH = process.env.TELEGRAM_API_HASH ?? '';

interface PendingAuth {
  client: TelegramClient;
  phoneNumber: string;
  phoneCodeHash: string;
  needsPassword: boolean;
  expiresAt: number;
}

interface QrAuth {
  client: TelegramClient;
  qrUrl: string | null;
  qrExpiresAt: number;
  done: boolean;
  error: string | null;
  needs2fa: boolean;
  resolve2fa: ((pw: string) => void) | null;
}

@Injectable()
export class TgAuthService {
  private readonly logger = new Logger(TgAuthService.name);
  private pending = new Map<string, PendingAuth>();
  private qrAuths = new Map<string, QrAuth>();

  constructor(private userbot: TgUserbotService) {}

  // ── QR code login (preferred) ──────────────────────────────────────────────

  /**
   * Start a QR login session. gramjs internally polls ExportLoginToken and
   * handles DC migration. Returns once the first QR URL is ready (~500ms).
   */
  async startQrLogin(userId: string): Promise<{ ok: boolean }> {
    if (!TG_API_ID || !TG_API_HASH) throw new Error('TELEGRAM_API_ID / TELEGRAM_API_HASH not set — get them at my.telegram.org and add to .env');

    this.cleanupQrAuth(userId);

    const client = new TelegramClient(new StringSession(''), TG_API_ID, TG_API_HASH, {
      connectionRetries: 3,
      baseLogger: silentTgLogger(),
    });
    await client.connect();

    const state: QrAuth = {
      client, qrUrl: null, qrExpiresAt: 0, done: false,
      error: null, needs2fa: false, resolve2fa: null,
    };
    this.qrAuths.set(userId, state);

    // Run the full QR login flow in the background.
    // signInUserWithQrCode internally: polls ExportLoginToken, listens for
    // UpdateLoginToken, handles LoginTokenMigrateTo DC switching.
    client.signInUserWithQrCode(
      { apiId: TG_API_ID, apiHash: TG_API_HASH },
      {
        qrCode: async ({ token, expires }: { token: Buffer; expires: number }) => {
          // Called once per QR cycle (~30s). Update state so the poll endpoint
          // always returns the freshest QR URL.
          const tokenB64 = Buffer.from(token).toString('base64url');
          state.qrUrl = `tg://login?token=${tokenB64}`;
          state.qrExpiresAt = expires * 1000;
        },
        password: async (_hint?: string): Promise<string> => {
          // 2FA — signal the frontend, then wait for the user to submit.
          state.needs2fa = true;
          return new Promise<string>((resolve) => {
            state.resolve2fa = resolve;
          });
        },
        onError: async (err: Error): Promise<boolean> => {
          this.logger.warn(`QR login error userId=${userId}: ${err.message}`);
          state.error = err.message;
          return false; // false = abort
        },
      } as any,
    )
      .then(async () => {
        if (!state.done) {
          const sessionString = client.session.save() as unknown as string;
          state.done = true;
          await this.userbot.connect(userId, sessionString);
          this.cleanupQrAuth(userId);
          this.logger.log(`QR login finalized for userId=${userId}`);
        }
      })
      .catch((err: Error) => {
        this.logger.warn(`QR login background error userId=${userId}: ${err.message}`);
        if (!state.done) state.error = err.message;
      });

    // Wait until first QR URL is ready (typically <500ms)
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 10_000;
      const iv = setInterval(() => {
        if (state.qrUrl) { clearInterval(iv); resolve(); }
        else if (state.error) { clearInterval(iv); reject(new Error(state.error)); }
        else if (Date.now() > deadline) { clearInterval(iv); reject(new Error('Timed out waiting for QR code')); }
      }, 50);
    });

    return { ok: true };
  }

  async pollQrLogin(userId: string): Promise<{
    status: 'pending' | 'success' | 'needs_2fa' | 'error';
    qrUrl?: string;
    error?: string;
  }> {
    const state = this.qrAuths.get(userId);

    // No pending state — might have already succeeded and cleaned up
    if (!state) {
      return this.userbot.isConnected(userId)
        ? { status: 'success' }
        : { status: 'error', error: 'No active QR session' };
    }

    if (state.done || this.userbot.isConnected(userId)) return { status: 'success' };
    if (state.needs2fa) return { status: 'needs_2fa' };
    if (state.error) return { status: 'error', error: state.error };
    return { status: 'pending', qrUrl: state.qrUrl ?? undefined };
  }

  async submitQr2fa(userId: string, password: string): Promise<void> {
    const state = this.qrAuths.get(userId);
    if (!state?.needs2fa || !state.resolve2fa) throw new Error('No pending 2FA for QR login');
    state.needs2fa = false;
    state.resolve2fa(password);
  }

  cancelQrLogin(userId: string): void {
    this.cleanupQrAuth(userId);
  }

  hasQrPending(userId: string): boolean {
    return this.qrAuths.has(userId);
  }

  // ── Phone auth (kept for fallback) ────────────────────────────────────────

  async sendCode(userId: string, phoneNumber: string): Promise<{ sent: boolean }> {
    if (!TG_API_ID || !TG_API_HASH) throw new Error('TELEGRAM_API_ID / TELEGRAM_API_HASH not configured');
    this.cleanupPending(userId);

    const session = new StringSession('');
    const client  = new TelegramClient(session, TG_API_ID, TG_API_HASH, {
      connectionRetries: 3,
      baseLogger: silentTgLogger(),
    });
    await client.connect();

    const { phoneCodeHash } = await client.sendCode({ apiId: TG_API_ID, apiHash: TG_API_HASH }, phoneNumber);
    this.pending.set(userId, { client, phoneNumber, phoneCodeHash, needsPassword: false, expiresAt: Date.now() + 10 * 60_000 });
    this.logger.log(`TG auth: code sent userId=${userId}`);
    return { sent: true };
  }

  async verifyCode(userId: string, code: string): Promise<{ ok: boolean; needs2fa?: boolean }> {
    const state = this.getPending(userId);
    try {
      await state.client.invoke(new Api.auth.SignIn({ phoneNumber: state.phoneNumber, phoneCodeHash: state.phoneCodeHash, phoneCode: code }));
    } catch (err: any) {
      if (err?.errorMessage === 'SESSION_PASSWORD_NEEDED' || err?.message?.includes('SESSION_PASSWORD_NEEDED')) {
        state.needsPassword = true;
        return { ok: false, needs2fa: true };
      }
      throw err;
    }
    return this.finalizePending(userId, state);
  }

  async verify2fa(userId: string, password: string): Promise<{ ok: boolean }> {
    const state = this.getPending(userId);
    if (!state.needsPassword) throw new Error('2FA not required');
    const pwResult = await state.client.invoke(new Api.account.GetPassword());
    const checkPw  = await computeCheck(pwResult as any, password);
    await state.client.invoke(new Api.auth.CheckPassword({ password: checkPw as any }));
    return this.finalizePending(userId, state);
  }

  hasPending(userId: string): boolean {
    const s = this.pending.get(userId);
    return !!s && s.expiresAt > Date.now();
  }

  pendingNeedsPassword(userId: string): boolean {
    return this.pending.get(userId)?.needsPassword ?? false;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async finalizePending(userId: string, state: PendingAuth): Promise<{ ok: boolean }> {
    const sessionString = state.client.session.save() as unknown as string;
    this.pending.delete(userId);
    await this.userbot.connect(userId, sessionString);
    this.logger.log(`TG phone auth finalized userId=${userId}`);
    return { ok: true };
  }

  private getPending(userId: string): PendingAuth {
    const state = this.pending.get(userId);
    if (!state) throw new Error('No pending auth — call send-code first');
    if (state.expiresAt < Date.now()) { this.cleanupPending(userId); throw new Error('Auth expired'); }
    return state;
  }

  private cleanupPending(userId: string) {
    const old = this.pending.get(userId);
    if (old) { old.client.disconnect().catch(() => {}); this.pending.delete(userId); }
  }

  private cleanupQrAuth(userId: string) {
    const state = this.qrAuths.get(userId);
    if (state) { state.client.disconnect().catch(() => {}); this.qrAuths.delete(userId); }
  }
}
