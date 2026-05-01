import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../ai-agent/llm.service';
import type {
  AiReasoning,
  AiVerdict,
  HolderMetrics,
  SafetySignals,
  SmartMoneyResult,
  SocialData,
  TokenMeta,
} from './token-analysis.types';

const CACHE_TTL_MS = 60_000;

const SYSTEM = `You are a professional crypto trader — sharp, greedy, and disciplined. You've made real money and you've been rugged. Both experiences made you better.

You think in risk/reward ratios, not vibes. You love asymmetric setups: clean safety profile, organic volume, early holder base, and a narrative with legs. You hate: honeypots, whale concentration, bundle launches, and hype without substance.

TRADING PHILOSOPHY:
- No honeypot = table stakes, not a bullish signal
- LP burned/locked = protects your exit, not your entry thesis
- Volume/MCap > 20% = genuine interest, not wash trading
- Top-10 holders < 30% = healthy distribution, exit risk low
- Bundle launch = deployer front-ran liquidity = hard pass unless volume proves otherwise
- Smart money holding = strongest signal of all — these wallets don't hold trash
- Domain < 7 days old + new Telegram = classic pump & dump setup
- Buy pressure > 60% sustained = real buyers, not bots
- Price impact > 10% at $1K = illiquid trap — your exit will move the market against you
- Organic score < 30 = manipulation detected, walk away
- Bonding curve < 50% = too early, high dump risk at graduation
- Chain TVL declining = macro headwind, reduce conviction

SCORING (100 pts total):
- Safety (35 pts): honeypot, LP status, mint/freeze authority, tax, rug score
- Distribution (30 pts): top-10 concentration, bundle supply %, smart money presence
- Market (20 pts): liquidity, vol/mcap, buy pressure, price impact, organic score, lifecycle stage
- Social (10 pts): Telegram size/activity, domain age, website history, Twitter presence
- Macro (5 pts): chain TVL trend, market conditions

VERDICTS:
- 80-100: STRONG_BUY — high conviction, size up
- 65-79:  BUY — good risk/reward, normal size
- 50-64:  CAUTIOUS — only with tight stop and small size
- 30-49:  SKIP — risk outweighs reward, wait for better setup
- 0-29:   HIGH_RISK — active red flags, stay out

CONTRADICTION DETECTION:
If safety looks clean but distribution is terrible (bundle > 15%), that contradiction must be flagged.
If volume is high but organic score is low, flag potential wash trading.
If smart money is in but bundle was detected, explain the tension.

SUMMARY RULES:
- 3-4 sentences, spoken like a trader giving a signal to a trusted friend
- CITE EXACT NUMBERS: "LP burned 97%, $1K buy impact 2.1%, 2,340 holders, buy pressure 71%"
- Never say "looks promising", "interesting project", "could be worth watching"
- End with a clear signal: "I'm in small", "hard pass", "wait for dip", "size up"
- For exit sizing: mention price impact numbers directly — "exit only works below $500 per trade"

Respond ONLY with valid JSON — no markdown, no explanation outside the JSON object.`;

function buildPrompt(
  meta: TokenMeta,
  safety: SafetySignals,
  holders: HolderMetrics | undefined,
  social: SocialData | undefined,
  smartMoney: SmartMoneyResult | undefined,
): string {
  const fmt = (n?: number | null, dec = 2) => (n != null ? n.toFixed(dec) : 'unknown');
  const fmtUsd = (n?: number | null) => {
    if (n == null) return 'unknown';
    if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
    return `$${n.toFixed(0)}`;
  };
  const b = meta.txns24h?.buys ?? 0, s = meta.txns24h?.sells ?? 0, t = b + s;
  const buyPressure = t ? `${((b / t) * 100).toFixed(0)}% buys (${b}/${s} txns)` : 'unknown';
  const volMcapRatio = (meta.volume24hUsd && meta.marketCapUsd && meta.marketCapUsd > 0)
    ? `${((meta.volume24hUsd / meta.marketCapUsd) * 100).toFixed(0)}%` : 'unknown';

  const bundle = holders?.bundleInfo;
  const lifecycle = holders?.lifecycle;
  const impact = holders?.priceImpact;
  const chainCtx = holders?.chainContext;

  return `TOKEN: ${meta.symbol ?? 'UNKNOWN'} (${meta.address.slice(0, 12)}...) on ${meta.chain}
CONTEXT: ${meta.pairAgeHours != null ? meta.pairAgeHours.toFixed(1) + 'h old' : 'age unknown'} | DEX: ${meta.dex ?? 'unknown'} | Chain: ${meta.chainId ?? meta.chain}

MARKET STRUCTURE:
- Price: $${fmt(meta.priceUsd, 6)}  MCap: ${fmtUsd(meta.marketCapUsd)}  FDV: ${fmtUsd(meta.fdvUsd)}
- Liquidity: ${fmtUsd(meta.liquidityUsd)}  Vol 24h: ${fmtUsd(meta.volume24hUsd)}  Vol/MCap: ${volMcapRatio}
- Buy pressure: ${buyPressure}
- Price changes: 5m ${fmt(meta.priceChange.m5)}%  1h ${fmt(meta.priceChange.h1)}%  6h ${fmt(meta.priceChange.h6)}%  24h ${fmt(meta.priceChange.h24)}%
- Organic score: ${holders?.organicScore != null ? holders.organicScore + '/100 (100=fully organic)' : 'unknown'}

SAFETY:
- Honeypot: ${safety.honeypot ?? 'unknown'}
- Mint authority: ${safety.mintAuthority == null ? 'unknown' : safety.mintAuthority ? 'ACTIVE WARNING — deployer can print tokens' : 'revoked (safe)'}
- Freeze authority: ${safety.freezeAuthority == null ? 'unknown' : safety.freezeAuthority ? 'ACTIVE WARNING — deployer can freeze balances' : 'revoked (safe)'}
- LP status: ${safety.lpLocked ?? 'unknown'}
- Buy tax: ${safety.buyTax != null ? (safety.buyTax / 100).toFixed(1) + '%' : '?'}  Sell tax: ${safety.sellTax != null ? (safety.sellTax / 100).toFixed(1) + '%' : '?'}
- Rug score: ${safety.rugScore != null ? safety.rugScore + '/100 (higher = worse)' : 'n/a'}
- Safety flags (${safety.flags.length}): ${safety.flags.length ? safety.flags.slice(0, 5).join(' | ') : 'none'}

DISTRIBUTION:
- Total holders: ${holders?.totalHolders ?? safety.holdersCount ?? 'unknown'}
- Top-10 concentration: ${holders?.top10ConcentrationPct != null ? fmt(holders.top10ConcentrationPct, 1) + '%' : safety.topHoldersPct != null ? fmt(safety.topHoldersPct, 1) + '%' : 'unknown'}
- Top-100 concentration: ${holders?.top100ConcentrationPct != null ? fmt(holders.top100ConcentrationPct, 1) + '%' : 'unknown'}
- BUNDLE DETECTION: ${bundle ? (bundle.detected ? `YES — ${bundle.bundleCount ?? '?'} bundle(s), ~${fmt(bundle.bundledSupplyPct, 1)}% supply grabbed at launch (source: ${bundle.source})` : `none detected (source: ${bundle.source})`) : 'not checked'}
${bundle?.bundledWallets?.length ? `- Bundled wallets: ${bundle.bundledWallets.slice(0, 5).join(', ')}` : ''}

LIFECYCLE (pump.fun / launch platform):
- Platform: ${lifecycle?.launchPlatform ?? 'unknown'}
- Stage: ${lifecycle?.stage ?? 'unknown'}
- Bonding curve progress: ${lifecycle?.bondingCurvePct != null ? lifecycle.bondingCurvePct.toFixed(1) + '%' : 'n/a'}
- King of the hill: ${lifecycle?.kingOfTheHill ? 'YES' : 'no'}

EXIT SIZING (price impact):
- $500 buy impact: ${impact?.buy500Usd != null ? fmt(impact.buy500Usd, 2) + '%' : 'unknown'}
- $1,000 buy impact: ${impact?.buy1000Usd != null ? fmt(impact.buy1000Usd, 2) + '%' : 'unknown'}
- $5,000 buy impact: ${impact?.buy5000Usd != null ? fmt(impact.buy5000Usd, 2) + '%' : 'unknown'}

SOCIAL:
- Twitter: ${social?.twitterUrl ? 'present' : 'none'}
- Telegram: ${social?.telegramUrl ? 'present' : 'none'}  Members: ${social?.telegramMembers != null ? social.telegramMembers.toLocaleString() : 'unknown'}
- Website: ${social?.websiteUrl ? 'present' : 'none'}  Domain age: ${social?.domainAgeDays != null ? social.domainAgeDays + ' days' : 'unknown'}
- Website recently changed: ${social?.websiteChanged ? 'YES — possible bait-and-switch' : 'no recent changes detected'}
- Social presence: ${social?.hasSocials ? 'yes (links in DEX data)' : 'none found in DEX data'}

SMART MONEY:
- Wallets with buy signals: ${smartMoney?.holdersFound ?? 0}
${smartMoney?.signals?.length ? smartMoney.signals.slice(0, 5).map((w) => `  - ${w.walletAddress.slice(0, 8)}... ${w.label ? `(${w.label})` : ''} winRate:${w.winRate ?? '?'}% action:${w.action ?? 'holding'}`).join('\n') : smartMoney?.holders.length ? smartMoney.holders.slice(0, 5).map((w) => `  - ${w.label}${w.winRate ? ' winRate:' + w.winRate + '%' : ''}`).join('\n') : '  (no smart money detected)'}

MACRO CONTEXT:
- Chain TVL: ${chainCtx?.tvlUsd != null ? fmtUsd(chainCtx.tvlUsd) : 'unknown'}
- TVL 7d change: ${chainCtx?.tvl7dChangePct != null ? fmt(chainCtx.tvl7dChangePct, 1) + '%' : 'unknown'}
- TVL 30d change: ${chainCtx?.tvl30dChangePct != null ? fmt(chainCtx.tvl30dChangePct, 1) + '%' : 'unknown'}

Reasoning steps to follow in your analysis:
1. Frame the token: chain, size, age, lifecycle stage — what kind of trade is this?
2. Safety walkthrough: what passed, what failed, what does it mean for getting rugged?
3. Distribution forensics: is supply concentrated or clean? was there a bundle launch?
4. Market quality: is liquidity real? is volume organic? can you actually exit at size?
5. Social + smart money synthesis: who's here and does community size match on-chain activity?
6. Macro + contradictions: what do chain TVL and cross-signal conflicts tell you?
7. Verdict: cite exact numbers, state the play clearly.

Respond ONLY with this exact JSON structure:
{
  "score": <integer 0-100>,
  "verdict": <"STRONG_BUY"|"BUY"|"CAUTIOUS"|"SKIP"|"HIGH_RISK">,
  "categoryScores": {
    "safety": <0-35>,
    "distribution": <0-30>,
    "market": <0-20>,
    "social": <0-10>,
    "macro": <0-5>
  },
  "categoryReasons": {
    "safety": "1-2 sentences: name specific checks that passed/failed and what they mean for rug risk.",
    "distribution": "1-2 sentences: cite concentration %, bundle status and % of supply, smart money count.",
    "market": "1-2 sentences: cite liquidity, vol/mcap, buy pressure, price impact, organic score.",
    "social": "1-2 sentences: cite Telegram size, domain age, website stability.",
    "macro": "1-2 sentences: cite TVL trend and what it means for this token's chain environment."
  },
  "contradictions": ["cross-signal conflict if any, e.g. 'Safety=clean but 23% bundled'"],
  "exitSizing": "Natural language exit guidance based on price impact data",
  "bullishSignals": ["specific signal with exact data", "specific signal with exact data"],
  "riskFactors": ["specific risk with exact data", "specific risk with exact data"],
  "summary": "3-4 sentences citing exact numbers. End with clear signal."
}`;
}

@Injectable()
export class AiReasoner {
  private readonly logger = new Logger(AiReasoner.name);
  private readonly cache = new Map<string, { result: AiReasoning; ts: number }>();

  constructor(private readonly llm: LlmService) {
    if (!llm.isConfigured) {
      this.logger.warn('No LLM provider configured — AI reasoning disabled. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.');
    } else {
      this.logger.log(`AI reasoning active via ${llm.activeProvider}`);
    }
  }

  async analyze(
    meta: TokenMeta,
    safety: SafetySignals,
    holders?: HolderMetrics,
    social?: SocialData,
    smartMoney?: SmartMoneyResult,
    profilePersona?: string,
    profileKey?: string,
  ): Promise<AiReasoning | null> {
    if (!this.llm.isConfigured) return null;

    const cacheKey = `${meta.chain}:${meta.address.toLowerCase()}:${profileKey ?? 'default'}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.result;

    const systemPrompt = profilePersona
      ? `TRADING PERSONA FOR THIS ANALYSIS:\n${profilePersona}\n\n---\n\n${SYSTEM}`
      : SYSTEM;

    try {
      const text = await this.llm.chat(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: buildPrompt(meta, safety, holders, social, smartMoney) },
        ],
        1800,
      );

      const jsonMatch = text.match(/\{[\s\S]+\}/);
      if (!jsonMatch) throw new Error('No JSON in LLM response');

      const parsed = JSON.parse(jsonMatch[0]);
      const cr = parsed.categoryReasons ?? {};

      const result: AiReasoning = {
        score: clamp(Number(parsed.score ?? 50), 0, 100),
        verdict: toVerdict(parsed.verdict),
        categoryScores: {
          safety:       clamp(Number(parsed.categoryScores?.safety       ?? 18), 0, 35),
          distribution: clamp(Number(parsed.categoryScores?.distribution ?? 15), 0, 30),
          market:       clamp(Number(parsed.categoryScores?.market       ?? 10), 0, 20),
          social:       clamp(Number(parsed.categoryScores?.social       ??  5), 0, 10),
          macro:        clamp(Number(parsed.categoryScores?.macro        ??  2), 0,  5),
        },
        categoryReasons: {
          safety:       typeof cr.safety       === 'string' ? cr.safety.slice(0, 400)       : undefined,
          distribution: typeof cr.distribution === 'string' ? cr.distribution.slice(0, 400) : undefined,
          market:       typeof cr.market       === 'string' ? cr.market.slice(0, 400)       : undefined,
          social:       typeof cr.social       === 'string' ? cr.social.slice(0, 400)       : undefined,
          macro:        typeof cr.macro        === 'string' ? cr.macro.slice(0, 400)        : undefined,
        },
        contradictions: Array.isArray(parsed.contradictions) ? parsed.contradictions.slice(0, 3) : [],
        exitSizing: typeof parsed.exitSizing === 'string' ? parsed.exitSizing.slice(0, 300) : undefined,
        bullishSignals: Array.isArray(parsed.bullishSignals) ? parsed.bullishSignals.slice(0, 5) : [],
        riskFactors:    Array.isArray(parsed.riskFactors)    ? parsed.riskFactors.slice(0, 5)    : [],
        summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 1000) : '',
        generatedAt: new Date().toISOString(),
      };

      this.cache.set(cacheKey, { result, ts: Date.now() });
      if (this.cache.size > 500) this.pruneCache();
      return result;
    } catch (e: any) {
      this.logger.warn(`AI reasoning failed for ${meta.address} (${this.llm.activeProvider}): ${e.message}`);
      return null;
    }
  }

  private pruneCache() {
    const cutoff = Date.now() - CACHE_TTL_MS;
    for (const [k, v] of this.cache) {
      if (v.ts < cutoff) this.cache.delete(k);
    }
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

const VALID_VERDICTS: AiVerdict[] = ['STRONG_BUY', 'BUY', 'CAUTIOUS', 'SKIP', 'HIGH_RISK'];

function toVerdict(v: string): AiVerdict {
  const upper = (v ?? '').toUpperCase().trim() as AiVerdict;
  return VALID_VERDICTS.includes(upper) ? upper : 'CAUTIOUS';
}
