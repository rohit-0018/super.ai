import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, createHash } from 'crypto';
import { Chain } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WalletVerifier } from './wallet-verifier';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

const ACCESS_TTL_SECONDS = parseDurationSeconds(process.env.JWT_EXPIRES_IN ?? '15m');
const REFRESH_TTL_MS = parseDurationSeconds(process.env.JWT_REFRESH_EXPIRES_IN ?? '7d') * 1000;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private verifier: WalletVerifier,
  ) {}

  async issueNonce(address: string, chain: Chain): Promise<string> {
    const nonce = randomBytes(16).toString('hex');
    const user = await this.upsertUserByWallet(address, chain);
    await this.prisma.session.create({
      data: {
        userId: user.id,
        refreshHash: 'pending',
        nonce,
        expiresAt: new Date(Date.now() + 5 * 60_000),
      },
    });
    return nonce;
  }

  async verifyAndIssueTokens(
    address: string,
    chain: Chain,
    signature: string,
    nonce: string,
  ): Promise<AuthTokens> {
    const session = await this.prisma.session.findFirst({
      where: { nonce, expiresAt: { gt: new Date() } },
      orderBy: { lastSeen: 'desc' },
    });
    if (!session) throw new UnauthorizedException('Nonce expired or unknown');

    const ok = this.verifier.verify(chain, address, nonce, signature);
    if (!ok) throw new UnauthorizedException('Bad signature');

    const tokens = await this.signTokens(session.userId, address);
    await this.prisma.session.update({
      where: { id: session.id },
      data: {
        nonce: null,
        refreshHash: hashToken(tokens.refreshToken),
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
        lastSeen: new Date(),
      },
    });
    await this.prisma.auditLog.create({
      data: { userId: session.userId, action: 'auth.verify', target: address },
    });
    return tokens;
  }

  /**
   * Rotate the refresh token: verify the incoming token matches a live session,
   * issue a fresh pair, and atomically swap the stored hash + extend expiry.
   *
   * If a client presents a refresh token whose hash no longer matches any session
   * (because it was already rotated or the session was invalidated), throw 401.
   * This catches both natural staleness and replay attempts.
   */
  async refresh(refreshToken: string): Promise<AuthTokens> {
    if (!refreshToken || typeof refreshToken !== 'string') {
      throw new UnauthorizedException('Missing refresh token');
    }
    const hash = hashToken(refreshToken);

    const session = await this.prisma.session.findFirst({ where: { refreshHash: hash } });
    if (!session || session.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token invalid or expired');
    }

    const tokens = await this.signTokens(session.userId);
    const newHash = hashToken(tokens.refreshToken);

    // Conditional update — only rotate if the hash still matches (prevents
    // concurrent refresh races from both succeeding).
    const rotated = await this.prisma.session.updateMany({
      where: { id: session.id, refreshHash: hash },
      data: {
        refreshHash: newHash,
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
        lastSeen: new Date(),
      },
    });
    if (rotated.count === 0) {
      throw new UnauthorizedException('Refresh token already rotated');
    }

    await this.prisma.auditLog.create({
      data: { userId: session.userId, action: 'auth.refresh', target: session.id },
    });
    return tokens;
  }

  async logout(refreshToken: string): Promise<void> {
    if (!refreshToken) return;
    const hash = hashToken(refreshToken);
    await this.prisma.session.updateMany({
      where: { refreshHash: hash },
      data: { refreshHash: 'revoked', expiresAt: new Date(0) },
    });
  }

  async getUserById(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, primaryWallet: true, createdAt: true, paperMode: true },
    });
    if (!user) throw new UnauthorizedException('User not found');
    return user;
  }

  async requestPhoneOtp(phone: string): Promise<void> {
    const normalized = phone.replace(/\D/g, '');
    if (normalized.length < 7 || normalized.length > 15) {
      throw new UnauthorizedException('Invalid phone number');
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpHash = createHash('sha256').update(otp).digest('hex');

    // Delete old unused OTPs for this phone
    await this.prisma.phoneOtp.deleteMany({ where: { phone: normalized, used: false } });

    await this.prisma.phoneOtp.create({
      data: {
        phone: normalized,
        otpHash,
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });

    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM;
    if (sid && token && from) {
      const body = encodeURIComponent(`Your QWAI verification code is ${otp}. Valid for 10 minutes.`);
      const to = encodeURIComponent(`+${normalized}`);
      const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `To=${to}&From=${encodeURIComponent(from)}&Body=${body}`,
      });
      if (!res.ok) {
        const text = await res.text();
        this.logger.error(`Twilio SMS failed: ${text}`);
        throw new UnauthorizedException('Failed to send SMS');
      }
    } else {
      this.logger.log(`[DEV] OTP for ${normalized}: ${otp}`);
    }
  }

  async verifyPhoneOtp(phone: string, otp: string): Promise<AuthTokens> {
    const normalized = phone.replace(/\D/g, '');
    const otpHash = createHash('sha256').update(otp).digest('hex');

    const record = await this.prisma.phoneOtp.findFirst({
      where: { phone: normalized, used: false, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });

    if (!record || record.otpHash !== otpHash) {
      throw new UnauthorizedException('Invalid or expired OTP');
    }

    await this.prisma.phoneOtp.update({ where: { id: record.id }, data: { used: true } });

    const user = await this.prisma.user.upsert({
      where: { phone: normalized },
      create: { phone: normalized },
      update: {},
    });

    const tokens = await this.signTokens(user.id, normalized);

    const session = await this.prisma.session.create({
      data: {
        userId: user.id,
        refreshHash: hashToken(tokens.refreshToken),
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      },
    });

    await this.prisma.auditLog.create({
      data: { userId: user.id, action: 'auth.phone.verify', target: normalized },
    });

    void session; // session stored; tokens carry the auth state
    return tokens;
  }

  private async upsertUserByWallet(address: string, _chain: Chain) {
    return this.prisma.user.upsert({
      where: { primaryWallet: address },
      update: {},
      create: { primaryWallet: address },
    });
  }

  private async signTokens(userId: string, address?: string): Promise<AuthTokens> {
    const accessToken = await this.jwt.signAsync({ sub: userId, address });
    const refreshToken = randomBytes(48).toString('base64url');
    return { accessToken, refreshToken, expiresIn: ACCESS_TTL_SECONDS };
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Parse "15m", "7d", "3600" → seconds. */
function parseDurationSeconds(v: string): number {
  const m = /^(\d+)\s*(s|m|h|d)?$/.exec(v.trim());
  if (!m) return 900;
  const n = parseInt(m[1], 10);
  switch (m[2]) {
    case 's': return n;
    case 'm': return n * 60;
    case 'h': return n * 3600;
    case 'd': return n * 86400;
    default: return n;
  }
}
