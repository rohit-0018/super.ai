import { Injectable, Logger } from '@nestjs/common';
import { Exchange } from '@prisma/client';
import crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { KmsService } from '../wallets/kms.service';
import { http } from '../common/http';

export interface BalanceRow {
  asset: string;
  free: string;
  locked?: string;
}

@Injectable()
export class CexService {
  private readonly logger = new Logger(CexService.name);
  constructor(private prisma: PrismaService, private kms: KmsService) {}

  async connect(userId: string, exchange: Exchange, apiKey: string, secret: string, passphrase?: string) {
    const k = await this.kms.encrypt(Buffer.from(apiKey));
    const s = await this.kms.encrypt(Buffer.from(passphrase ? `${secret}::${passphrase}` : secret));
    return this.prisma.cexConnection.upsert({
      where: { userId_exchange: { userId, exchange } },
      update: { encryptedApiKey: k.ciphertext, encryptedSecret: s.ciphertext, encryptedDek: k.encryptedDek },
      create: {
        userId,
        exchange,
        encryptedApiKey: k.ciphertext,
        encryptedSecret: s.ciphertext,
        encryptedDek: k.encryptedDek,
      },
    });
  }

  async unifiedPortfolio(userId: string) {
    const conns = await this.prisma.cexConnection.findMany({ where: { userId } });
    const out: Record<string, BalanceRow[] | { error: string }> = {};
    for (const c of conns) {
      try {
        out[c.exchange] = await this.fetchBalance(c);
      } catch (e: any) {
        this.logger.warn(`${c.exchange} balance fetch failed: ${e.message}`);
        out[c.exchange] = { error: e.message };
      }
    }
    return out;
  }

  private async fetchBalance(conn: {
    exchange: Exchange;
    encryptedApiKey: string;
    encryptedSecret: string;
    encryptedDek: string;
  }): Promise<BalanceRow[]> {
    const apiKey = (
      await this.kms.decrypt({ ciphertext: conn.encryptedApiKey, encryptedDek: conn.encryptedDek })
    ).toString();
    const secretRaw = (
      await this.kms.decrypt({ ciphertext: conn.encryptedSecret, encryptedDek: conn.encryptedDek })
    ).toString();

    switch (conn.exchange) {
      case Exchange.BINANCE:
        return this.binanceBalances(apiKey, secretRaw);
      case Exchange.BYBIT:
        return this.bybitBalances(apiKey, secretRaw);
      case Exchange.OKX: {
        const [secret, passphrase] = secretRaw.split('::');
        return this.okxBalances(apiKey, secret, passphrase ?? '');
      }
    }
  }

  private async binanceBalances(apiKey: string, secret: string): Promise<BalanceRow[]> {
    const ts = Date.now();
    const query = `timestamp=${ts}&recvWindow=5000`;
    const sig = crypto.createHmac('sha256', secret).update(query).digest('hex');
    const r: any = await http.get(`https://api.binance.com/api/v3/account?${query}&signature=${sig}`, {
      headers: { 'X-MBX-APIKEY': apiKey },
      timeoutMs: 8_000,
    });
    return (r?.balances ?? [])
      .filter((b: any) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0)
      .map((b: any) => ({ asset: b.asset, free: b.free, locked: b.locked }));
  }

  // Bybit v5 — https://bybit-exchange.github.io/docs/v5/account/wallet-balance
  private async bybitBalances(apiKey: string, secret: string): Promise<BalanceRow[]> {
    const ts = Date.now().toString();
    const recvWindow = '5000';
    const query = 'accountType=UNIFIED';
    const preSign = ts + apiKey + recvWindow + query;
    const sign = crypto.createHmac('sha256', secret).update(preSign).digest('hex');
    const r: any = await http.get(`https://api.bybit.com/v5/account/wallet-balance?${query}`, {
      headers: {
        'X-BAPI-API-KEY': apiKey,
        'X-BAPI-SIGN': sign,
        'X-BAPI-TIMESTAMP': ts,
        'X-BAPI-RECV-WINDOW': recvWindow,
      },
      timeoutMs: 8_000,
    });
    const coins: any[] = r?.result?.list?.[0]?.coin ?? [];
    return coins
      .filter((c) => parseFloat(c.walletBalance) > 0)
      .map((c) => ({ asset: c.coin, free: c.availableToWithdraw ?? c.walletBalance, locked: c.locked }));
  }

  // OKX v5 — https://www.okx.com/docs-v5/en/#rest-api-account-get-balance
  private async okxBalances(apiKey: string, secret: string, passphrase: string): Promise<BalanceRow[]> {
    const ts = new Date().toISOString();
    const method = 'GET';
    const path = '/api/v5/account/balance';
    const preSign = ts + method + path;
    const sign = crypto.createHmac('sha256', secret).update(preSign).digest('base64');
    const r: any = await http.get(`https://www.okx.com${path}`, {
      headers: {
        'OK-ACCESS-KEY': apiKey,
        'OK-ACCESS-SIGN': sign,
        'OK-ACCESS-TIMESTAMP': ts,
        'OK-ACCESS-PASSPHRASE': passphrase,
      },
      timeoutMs: 8_000,
    });
    const details: any[] = r?.data?.[0]?.details ?? [];
    return details
      .filter((d) => parseFloat(d.availBal ?? '0') > 0 || parseFloat(d.cashBal ?? '0') > 0)
      .map((d) => ({ asset: d.ccy, free: d.availBal ?? d.cashBal, locked: d.frozenBal }));
  }
}
