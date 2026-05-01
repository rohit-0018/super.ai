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
- Top-10 holders < 30% = healthy distribution, exit risk is low
- Bundle launch = deployer front-ran liquidity = hard pass unless volume proves otherwise
- Smart money holding = strongest signal of all — these wallets don't hold trash
- Domain < 7 days old + new Telegram = classic pump & dump setup
- Buy pressure > 60% sustained = real buyers, not bots

SCORING (100 pts total):
- Safety (30 pts): honeypot, LP status, mint/freeze authority, tax structure, rug score
- Market (20 pts): liquidity (>$50K threshold), vol/mcap ratio, buy pressure, pair age
- Holders (20 pts): top-10 concentration, bundle-free launch, deployer behavior
- Social (15 pts): Telegram member count, domain age, multi-platform presence
- Momentum (15 pts): price action across 5m/1h/6h/24h, volume confirming or contradicting moves

VERDICTS:
- 80-100: STRONG_BUY — high conviction, size up
- 65-79:  BUY — good risk/reward, normal size
- 50-64:  CAUTIOUS — only with tight stop and small size
- 30-49:  SKIP — risk outweighs reward, wait for better setup
- 0-29:   HIGH_RISK — active red flags, stay out

SUMMARY RULES:
- 3-4 sentences, spoken like a trader giving a signal to a trusted friend
- CITE EXACT NUMBERS — "LP burned 97%, 2,340 holders growing 200/hour, buy pressure 71%"
- Never say "looks promising", "interesting project", or "could be worth watching"
- End with a clear signal: "I'm in small", "hard pass", "wait for dip", "size up"

Respond ONLY with valid JSON — no markdown, no explanation outside the JSON object.`;

function buildPrompt(
  meta: TokenMeta,
  safety: SafetySignals,
  holders: HolderMetrics | undefined,
  social: SocialData | undefined,
  smartMoney: SmartMoneyResult | undefined,
): string {
  const fmt = (n?: number, dec = 2) => (n != null ? n.toFixed(dec) : 'unknown');
  const fmtUsd = (n?: number) => {
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

  return `TOKEN: ${meta.symbol ?? 'UNKNOWN'} (${meta.address.slice(0, 12)}...) on ${meta.chain}
CONTEXT: ${meta.pairAgeHours != null ? meta.pairAgeHours.toFixed(1) + 'h old' : 'age unknown'} on ${meta.dex ?? 'unknown dex'}

MARKET STRUCTURE:
- Price: $${fmt(meta.priceUsd, 6)}  MCap: ${fmtUsd(meta.marketCapUsd)}  FDV: ${fmtUsd(meta.fdvUsd)}
- Liquidity: ${fmtUsd(meta.liquidityUsd)}  Vol 24h: ${fmtUsd(meta.volume24hUsd)}  Vol/MCap: ${volMcapRatio}
- Buy pressure: ${buyPressure}
- Price: 5m ${fmt(meta.priceChange.m5)}%  1h ${fmt(meta.priceChange.h1)}%  6h ${fmt(meta.priceChange.h6)}%  24h ${fmt(meta.priceChange.h24)}%

SAFETY:
- Honeypot: ${safety.honeypot ?? 'unknown'}
- Mint authority: ${safety.mintAuthority == null ? 'unknown' : safety.mintAuthority ? 'ACTIVE WARNING' : 'revoked (safe)'}
- Freeze authority: ${safety.freezeAuthority == null ? 'unknown' : safety.freezeAuthority ? 'ACTIVE WARNING' : 'revoked (safe)'}
- LP locked: ${safety.lpLocked ?? 'unknown'}
- Buy tax: ${safety.buyTax != null ? (safety.buyTax / 100).toFixed(1) + '%' : '?'}  Sell tax: ${safety.sellTax != null ? (safety.sellTax / 100).toFixed(1) + '%' : '?'}
- Risk score: ${safety.rugScore != null ? safety.rugScore + '/100 (higher = worse)' : 'n/a'}
- Flags (${safety.flags.length}): ${safety.flags.length ? safety.flags.slice(0, 5).join(' | ') : 'none'}

HOLDERS:
- Total holders: ${holders?.totalHolders ?? safety.holdersCount ?? 'unknown'}
- Top 10 concentration: ${holders?.top10ConcentrationPct != null ? fmt(holders.top10ConcentrationPct, 1) + '%' : safety.topHoldersPct != null ? fmt(safety.topHoldersPct, 1) + '%' : 'unknown'}
- Bundle at launch: ${holders?.bundleDetected != null ? (holders.bundleDetected ? 'YES — deployer front-ran own liquidity (bad)' : 'none detected (clean)') : 'unknown'}

SOCIAL:
- Twitter: ${social?.twitterUrl ? 'present' : 'none'}
- Telegram: ${social?.telegramUrl ? 'present' : 'none'}  Members: ${social?.telegramMembers != null ? social.telegramMembers.toLocaleString() : 'unknown'}
- Website: ${social?.websiteUrl ? 'present' : 'none'}  Domain age: ${social?.domainAgeDays != null ? social.domainAgeDays + ' days' : 'unknown'}
- Social presence: ${social?.hasSocials ? 'yes' : 'none found in DEX data'}

SMART MONEY (curated wallet check):
- Wallets checked: ${smartMoney?.walletsChecked ?? 0}  Holding token: ${smartMoney?.holdersFound ?? 0}
${smartMoney?.holders.length ? smartMoney.holders.map((w) => `  - ${w.label}`).join('\n') : '  (none holding or no wallets configured)'}

Follow these 6 reasoning steps in your analysis (your JSON output should reflect this depth):
1. Frame what this token is — age, chain, size context
2. Walk through each safety check and explain what passing/failing means for rug risk
3. Evaluate market structure — is liquidity real? is volume organic? what does buy pressure imply?
4. Read the holder distribution — concentration tells a story, bundle launch is a red flag
5. Synthesize social and smart money — size, age, credibility
6. Issue your verdict with precise data citations

Respond ONLY with this exact JSON structure:
{
  "score": <integer 0-100>,
  "verdict": <"STRONG_BUY"|"BUY"|"CAUTIOUS"|"SKIP"|"HIGH_RISK">,
  "categoryScores": { "safety": <0-30>, "market": <0-20>, "holders": <0-20>, "social": <0-15>, "momentum": <0-15> },
  "categoryReasons": {
    "safety": "1-2 sentences: name specific checks that passed/failed and what they mean for rug risk.",
    "market": "1-2 sentences: cite liquidity depth, vol/mcap ratio, buy pressure and what they imply about organic vs manufactured activity.",
    "holders": "1-2 sentences: cite the concentration number, bundle status, and what the distribution implies about exit risk.",
    "social": "1-2 sentences: cite community size, domain age, and whether the social presence looks legitimate.",
    "momentum": "1-2 sentences: cite price action across timeframes and whether volume confirms or contradicts the move."
  },
  "bullishSignals": ["specific signal with data", "specific signal with data", "specific signal with data"],
  "riskFactors": ["specific risk with data", "specific risk with data", "specific risk with data"],
  "summary": "3-4 sentences citing exact numbers. Not generic — say LP is 97% burned, not just LP is locked."
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
  ): Promise<AiReasoning | null> {
    if (!this.llm.isConfigured) return null;

    const cacheKey = `${meta.chain}:${meta.address.toLowerCase()}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.result;

    try {
      const text = await this.llm.chat(
        [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: buildPrompt(meta, safety, holders, social, smartMoney) },
        ],
        1500,
      );

      const jsonMatch = text.match(/\{[\s\S]+\}/);
      if (!jsonMatch) throw new Error('No JSON in LLM response');

      const parsed = JSON.parse(jsonMatch[0]);
      const cr = parsed.categoryReasons ?? {};

      const result: AiReasoning = {
        score: clamp(Number(parsed.score ?? 50), 0, 100),
        verdict: toVerdict(parsed.verdict),
        categoryScores: {
          safety:   clamp(Number(parsed.categoryScores?.safety   ?? 15), 0, 30),
          market:   clamp(Number(parsed.categoryScores?.market   ?? 10), 0, 20),
          holders:  clamp(Number(parsed.categoryScores?.holders  ?? 10), 0, 20),
          social:   clamp(Number(parsed.categoryScores?.social   ??  7), 0, 15),
          momentum: clamp(Number(parsed.categoryScores?.momentum ??  7), 0, 15),
        },
        categoryReasons: {
          safety:   typeof cr.safety   === 'string' ? cr.safety.slice(0, 400)   : undefined,
          market:   typeof cr.market   === 'string' ? cr.market.slice(0, 400)   : undefined,
          holders:  typeof cr.holders  === 'string' ? cr.holders.slice(0, 400)  : undefined,
          social:   typeof cr.social   === 'string' ? cr.social.slice(0, 400)   : undefined,
          momentum: typeof cr.momentum === 'string' ? cr.momentum.slice(0, 400) : undefined,
        },
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
