import { Injectable, UnauthorizedException } from '@nestjs/common';
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
