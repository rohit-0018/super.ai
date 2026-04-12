import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class RateLimitMonitor {
  private readonly logger = new Logger(RateLimitMonitor.name);
  private counters = new Map<string, { count: number; windowStart: number }>();
  private readonly windowMs = 60_000;

  track(service: string) {
    const now = Date.now();
    let entry = this.counters.get(service);
    if (!entry || now - entry.windowStart > this.windowMs) {
      entry = { count: 0, windowStart: now };
      this.counters.set(service, entry);
    }
    entry.count++;
  }

  check(service: string, limit: number): { usage: number; pct: number; warning: boolean } {
    const entry = this.counters.get(service);
    const usage = entry?.count ?? 0;
    const pct = Math.round((usage / limit) * 100);
    const warning = pct >= 80;
    if (warning) {
      this.logger.warn(`${service} rate limit at ${pct}% (${usage}/${limit}) — approaching cap`);
    }
    return { usage, pct, warning };
  }

  status(): Record<string, { count: number; pct: number }> {
    const out: Record<string, { count: number; pct: number }> = {};
    const limits: Record<string, number> = {
      'CoinGecko': 30,
      'Birdeye': 100,
      'GoPlus': 60,
      'RugCheck': 60,
      'Jupiter': 120,
      '1inch': 60,
      'CryptoPanic': 20,
    };
    for (const [svc, entry] of this.counters.entries()) {
      const limit = limits[svc] ?? 100;
      out[svc] = { count: entry.count, pct: Math.round((entry.count / limit) * 100) };
    }
    return out;
  }
}
