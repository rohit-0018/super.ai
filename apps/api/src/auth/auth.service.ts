import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, createHash } from 'crypto';
import { Chain } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WalletVerifier } from './wallet-verifier';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

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

  async verifyAndIssueTokens(address: string, chain: Chain, signature: string, nonce: string): Promise<AuthTokens> {
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
        refreshHash: createHash('sha256').update(tokens.refreshToken).digest('hex'),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
      },
    });
    await this.prisma.auditLog.create({
      data: { userId: session.userId, action: 'auth.verify', target: address },
    });
    return tokens;
  }

  async refresh(refreshToken: string): Promise<AuthTokens> {
    const hash = createHash('sha256').update(refreshToken).digest('hex');
    const session = await this.prisma.session.findFirst({ where: { refreshHash: hash } });
    if (!session || session.expiresAt < new Date()) throw new UnauthorizedException();
    return this.signTokens(session.userId);
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
    return { accessToken, refreshToken };
  }
}
