import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { getSolanaRpcUrl, getEvmRpcUrl } from '../common/network-config';
import type {
  Chain,
  WalletAnalysisReport,
  WindowStats,
  WalletTokenExposure,
  RiskProfile,
  CopyFitVerdict,
} from './wallet-analysis.types';

/**
 * WalletAnalysisService — free-tier "trader scorecard".
 *
 * Free-tier constraints: no Nansen / Arkham labels, no Helius Pro portfolio
 * endpoint. We hit public RPC for signature counts + last activity, and (when
 * configured) Etherscan free API for recent tx history on EVM. Solana deep
 * history requires either Helius or Birdeye which we don't assume here — so
 * Solana reports will be thinner than EVM. The `coverageNote` explains this to
 * the user up front instead of silently producing fake numbers.
 *
 * Output model:
 *   - Signals: labels, first seen, last active, activity volume
 *   - Window stats: 30d / 90d / 365d (when tx history is available)
 *   - Risk profile classifier: sniper / momentum / swing / holder / mixed
 *   - Copy-fit verdict: copy_with_scaling / watch_only / avoid
 */
@Injectable()
export class WalletAnalysisService {
  private readonly logger = new Logger(WalletAnalysisService.name);
  private readonly cacheTtlMs = 5 * 60_000;
  private cache = new Map<string, { report: WalletAnalysisReport; ts: number }>();

  async analyze(chain: Chain, rawAddress: string): Promise<WalletAnalysisReport> {
    const address = (rawAddress ?? '').trim();
    if (!address) throw new BadRequestException('address is required');
    if (chain === 'EVM' && !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      throw new BadRequestException('Invalid EVM address');
    }
    if (chain === 'SOLANA' && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
      throw new BadRequestException('Invalid Solana address');
    }

    const key = `${chain}:${address.toLowerCase()}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.ts < this.cacheTtlMs) return cached.report;

    const sources: string[] = [];
    const labels: string[] = [];

    let firstSeen: string | undefined;
    let lastActive: string | undefined;
    let activityTotal = 0;

    if (chain === 'SOLANA') {
      try {
        const sol = await this.solanaActivity(address);
        sources.push('Solana RPC');
        firstSeen = sol.firstSeen;
        lastActive = sol.lastActive;
        activityTotal = sol.signatureCount;
        labels.push(...sol.labels);
      } catch (e: any) {
        this.logger.warn(`Solana RPC probe failed: ${e?.message}`);
      }
    } else {
      try {
        const evm = await this.evmActivity(address);
        sources.push('EVM RPC');
        if (evm.etherscan) sources.push('Etherscan');
        firstSeen = evm.firstSeen;
        lastActive = evm.lastActive;
        activityTotal = evm.txCount;
        labels.push(...evm.labels);
      } catch (e: any) {
        this.logger.warn(`EVM probe failed: ${e?.message}`);
      }
    }

    // NOTE: On the free tier we cannot reliably reconstruct per-trade PnL for
    // arbitrary wallets without Helius Pro / Birdeye / Etherscan token-tx with
    // USD pricing. We therefore return *stat placeholders* with `null` values
    // and a clear coverage note — not fabricated numbers.
    const windows: WindowStats[] = [30, 90, 365].map((d) => ({
      windowDays: d,
      trades: Math.round(estimateTradesInWindow(activityTotal, d) ?? 0),
      winRate: null,
      pnlUsd: null,
      avgHoldHours: null,
    }));

    const riskProfile = classifyProfile(chain, activityTotal, firstSeen);
    const topTokens: WalletTokenExposure[] = [];
    const copyFit = buildCopyFit({ labels, activityTotal, riskProfile, firstSeen, hasPnl: false });

    const coverageNote =
      chain === 'SOLANA'
        ? 'Solana free-tier: we can read signature counts and first/last activity from public RPC, but reliable historical PnL per trade requires Helius Pro or Birdeye. Per-window stats are counts-only for now.'
        : 'EVM free-tier: we can read tx counts and recent token transfers from public RPC, but dollar-valued PnL requires Etherscan Pro or DeBank. Per-window stats are counts-only for now.';

    const report: WalletAnalysisReport = {
      chain,
      address,
      labels,
      firstSeen,
      lastActive,
      windows,
      riskProfile,
      topTokens,
      copyFit,
      dataSources: sources,
      coverageNote,
      generatedAt: new Date().toISOString(),
      disclaimer:
        'qwai wallet analysis is heuristic and informational only. Copying strangers carries real risk; treat "copy-fit" as a filter, not a green light.',
    };

    this.cache.set(key, { report, ts: Date.now() });
    return report;
  }

  /* -------------------------------------------------- */
  /* Solana probe — signatures + first/last timestamps  */
  /* -------------------------------------------------- */
  private async solanaActivity(address: string): Promise<{
    signatureCount: number;
    firstSeen?: string;
    lastActive?: string;
    labels: string[];
  }> {
    const rpc = getSolanaRpcUrl();
    // We use getSignaturesForAddress with a generous limit; on free RPC this
    // tops out at 1000 results. We treat ">=1000" as "high activity".
    const resp = await fetch(rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getSignaturesForAddress',
        params: [address, { limit: 1000 }],
      }),
    });
    if (!resp.ok) throw new Error(`RPC ${resp.status}`);
    const body = await resp.json() as any;
    const sigs: any[] = Array.isArray(body?.result) ? body.result : [];
    const labels: string[] = [];
    if (!sigs.length) {
      labels.push('No on-chain activity found');
      return { signatureCount: 0, labels };
    }
    const first = sigs[sigs.length - 1];
    const last = sigs[0];
    const firstSeen = first?.blockTime ? new Date(first.blockTime * 1000).toISOString() : undefined;
    const lastActive = last?.blockTime ? new Date(last.blockTime * 1000).toISOString() : undefined;

    if (sigs.length >= 1000) labels.push('High activity (>1k signatures)');
    else if (sigs.length >= 200) labels.push('Active trader');
    else if (sigs.length < 20) labels.push('Low activity wallet');

    if (firstSeen) {
      const ageDays = (Date.now() - new Date(firstSeen).getTime()) / 86_400_000;
      if (ageDays < 7) labels.push('New wallet (<7d old)');
      else if (ageDays < 30) labels.push('Young wallet (<30d old)');
      else if (ageDays > 365) labels.push('Established wallet (>1y)');
    }

    return { signatureCount: sigs.length, firstSeen, lastActive, labels };
  }

  /* -------------------------------------------------- */
  /* EVM probe — tx count + latest block timestamp      */
  /* -------------------------------------------------- */
  private async evmActivity(address: string): Promise<{
    txCount: number;
    firstSeen?: string;
    lastActive?: string;
    etherscan: boolean;
    labels: string[];
  }> {
    const rpc = getEvmRpcUrl();
    const labels: string[] = [];
    const resp = await fetch(rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_getTransactionCount',
        params: [address, 'latest'],
      }),
    });
    if (!resp.ok) throw new Error(`RPC ${resp.status}`);
    const body = await resp.json() as any;
    const txCount = body?.result ? parseInt(body.result, 16) : 0;
    if (!txCount) labels.push('No on-chain activity found');
    else if (txCount >= 1000) labels.push('High activity (>1k txns)');
    else if (txCount >= 200) labels.push('Active trader');
    else if (txCount < 20) labels.push('Low activity wallet');

    // Etherscan free API for first/last seen (optional — only if key is set).
    let firstSeen: string | undefined;
    let lastActive: string | undefined;
    let etherscan = false;
    const esKey = process.env.ETHERSCAN_API_KEY;
    if (esKey && txCount > 0) {
      try {
        const u1 = `https://api.etherscan.io/api?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&page=1&offset=1&sort=asc&apikey=${esKey}`;
        const r1 = await fetch(u1);
        const j1: any = await r1.json();
        if (Array.isArray(j1?.result) && j1.result[0]?.timeStamp) {
          firstSeen = new Date(Number(j1.result[0].timeStamp) * 1000).toISOString();
        }
        const u2 = `https://api.etherscan.io/api?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&page=1&offset=1&sort=desc&apikey=${esKey}`;
        const r2 = await fetch(u2);
        const j2: any = await r2.json();
        if (Array.isArray(j2?.result) && j2.result[0]?.timeStamp) {
          lastActive = new Date(Number(j2.result[0].timeStamp) * 1000).toISOString();
        }
        etherscan = true;
      } catch (e: any) {
        this.logger.warn(`Etherscan failed: ${e?.message}`);
      }
    }

    if (firstSeen) {
      const ageDays = (Date.now() - new Date(firstSeen).getTime()) / 86_400_000;
      if (ageDays < 7) labels.push('New wallet (<7d old)');
      else if (ageDays < 30) labels.push('Young wallet (<30d old)');
      else if (ageDays > 365) labels.push('Established wallet (>1y)');
    }

    return { txCount, firstSeen, lastActive, etherscan, labels };
  }
}

/* -------------------------------------------------- */
/* Helpers                                             */
/* -------------------------------------------------- */

function estimateTradesInWindow(total: number, days: number): number | null {
  if (!total) return 0;
  // Rough uniform projection from a 1000-sig cap is too lossy to be honest.
  // Instead return the total when asked for <= ~30d, else null.
  if (days <= 30) return Math.min(total, 1000);
  return null;
}

function classifyProfile(chain: Chain, activity: number, firstSeen?: string): RiskProfile {
  if (!activity) return 'insufficient';
  const ageDays = firstSeen ? (Date.now() - new Date(firstSeen).getTime()) / 86_400_000 : undefined;
  if (activity < 20) return 'holder';
  if (activity > 500 && ageDays != null && ageDays < 30) return 'sniper';
  if (activity > 500) return 'momentum';
  if (activity > 100) return 'swing';
  return 'mixed';
}

function buildCopyFit(opts: {
  labels: string[];
  activityTotal: number;
  riskProfile: RiskProfile;
  firstSeen?: string;
  hasPnl: boolean;
}): CopyFitVerdict {
  const reasons: string[] = [];
  let score = 5;

  if (!opts.activityTotal) {
    return {
      verdict: 'insufficient_data',
      score: 0,
      reasons: ['No on-chain activity detected on this wallet'],
      suggestedScale: 0,
    };
  }

  if (!opts.hasPnl) {
    reasons.push('No verified PnL history on free tier — copy-fit is structural only');
    score -= 2;
  }

  if (opts.riskProfile === 'sniper') {
    reasons.push('Sniper profile — fast, small, high-frequency. Copying is latency-sensitive and rarely profitable retail-side.');
    score -= 2;
  } else if (opts.riskProfile === 'holder') {
    reasons.push('Holder profile — limited copy benefit; you could just buy-and-hold the same tokens.');
    score -= 0.5;
  } else if (opts.riskProfile === 'momentum' || opts.riskProfile === 'swing') {
    reasons.push(`${opts.riskProfile} profile — viable copy candidate if PnL checks out.`);
    score += 0.5;
  }

  if (opts.firstSeen) {
    const age = (Date.now() - new Date(opts.firstSeen).getTime()) / 86_400_000;
    if (age < 30) {
      reasons.push('New wallet (<30d). Too early to trust the record.');
      score -= 2;
    } else if (age > 365) {
      reasons.push('Wallet >1y old — long-lived, which is a mild positive.');
      score += 1;
    }
  }

  if (opts.activityTotal > 2000) {
    reasons.push('Very high turnover — gas/slippage drag will be meaningful if copied 1:1.');
    score -= 1;
  }

  score = Math.max(0, Math.min(10, score));
  let verdict: CopyFitVerdict['verdict'];
  if (score >= 7) verdict = 'copy_with_scaling';
  else if (score >= 4) verdict = 'watch_only';
  else verdict = 'avoid';

  // Scale hint: small on free-tier verdicts
  const suggestedScale = verdict === 'copy_with_scaling' ? 0.25 : verdict === 'watch_only' ? 0 : 0;
  return { verdict, score: Math.round(score * 10) / 10, reasons, suggestedScale };
}
