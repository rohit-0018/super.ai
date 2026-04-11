import { Injectable } from '@nestjs/common';

export interface ConvictionInputs {
  securityScore?: number | null;       // 0..100
  holderQuality?: number | null;       // 0..100
  liquidityScore?: number | null;      // 0..100
  sentimentScore?: number | null;      // -1..1
  momentumScore?: number | null;       // -1..1
  riskFlags?: string[];
}

/**
 * Multi-signal aggregation → 1..10 conviction score (PDF §3.3 W2 #6).
 * Weighted blend, risk flags hard-cap the result.
 */
@Injectable()
export class ConvictionEngine {
  score(inp: ConvictionInputs): number {
    const w = {
      security: 0.30,
      holder: 0.20,
      liquidity: 0.15,
      sentiment: 0.20,
      momentum: 0.15,
    };
    const sec = (inp.securityScore ?? 50) / 100;
    const hold = (inp.holderQuality ?? 50) / 100;
    const liq = (inp.liquidityScore ?? 50) / 100;
    const sent = ((inp.sentimentScore ?? 0) + 1) / 2;
    const mom = ((inp.momentumScore ?? 0) + 1) / 2;
    const blended = sec * w.security + hold * w.holder + liq * w.liquidity + sent * w.sentiment + mom * w.momentum;
    let score = 1 + blended * 9;
    if (inp.riskFlags?.length) {
      score = Math.min(score, inp.riskFlags.includes('HONEYPOT') ? 1 : 4);
    }
    return Math.round(score * 10) / 10;
  }
}
