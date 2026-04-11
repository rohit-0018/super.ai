import { Injectable } from '@nestjs/common';
import { Exchange } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { KmsService } from '../wallets/kms.service';
import axios from 'axios';
import crypto from 'crypto';

@Injectable()
export class CexService {
  constructor(private prisma: PrismaService, private kms: KmsService) {}

  async connect(userId: string, exchange: Exchange, apiKey: string, secret: string) {
    const k = await this.kms.encrypt(Buffer.from(apiKey));
    const s = await this.kms.encrypt(Buffer.from(secret));
    return this.prisma.cexConnection.upsert({
      where: { userId_exchange: { userId, exchange } },
      update: { encryptedApiKey: k.ciphertext, encryptedSecret: s.ciphertext, encryptedDek: k.encryptedDek },
      create: {
        userId, exchange, encryptedApiKey: k.ciphertext, encryptedSecret: s.ciphertext, encryptedDek: k.encryptedDek,
      },
    });
  }

  async unifiedPortfolio(userId: string) {
    const conns = await this.prisma.cexConnection.findMany({ where: { userId } });
    const out: Record<string, unknown> = {};
    for (const c of conns) {
      try { out[c.exchange] = await this.fetchBalance(c); }
      catch (e: any) { out[c.exchange] = { error: e.message }; }
    }
    return out;
  }

  private async fetchBalance(conn: any) {
    const apiKey = (await this.kms.decrypt({ ciphertext: conn.encryptedApiKey, encryptedDek: conn.encryptedDek })).toString();
    const secret = (await this.kms.decrypt({ ciphertext: conn.encryptedSecret, encryptedDek: conn.encryptedDek })).toString();
    if (conn.exchange === 'BINANCE') {
      const ts = Date.now();
      const query = `timestamp=${ts}`;
      const sig = crypto.createHmac('sha256', secret).update(query).digest('hex');
      const r = await axios.get(`https://api.binance.com/api/v3/account?${query}&signature=${sig}`, {
        headers: { 'X-MBX-APIKEY': apiKey }, timeout: 8000,
      });
      return r.data?.balances?.filter((b: any) => parseFloat(b.free) > 0);
    }
    return { note: `${conn.exchange} fetch not implemented in MVP scaffold` };
  }
}
