import { Injectable, Logger, Optional } from '@nestjs/common';
import { TwitterApiIoProvider } from './twitter-api-io.provider';
import { computeTweetRelevance, extractProjectKeywords, type TweetRich } from './twitter-relevance';

/**
 * Aggregated mention-statistics for a single token, computed from a fresh
 * TwitterAPI.io search. Used by the hot-tokens scorer as a social-hype pillar.
 *
 * All fields are RELEVANCE-FILTERED: only tweets that pass the project-aligned
 * relevance threshold (cashtag + context word, CA in body, project-handle
 * authorship, or narrative-keyword overlap) are counted. This is what
 * separates "$PROG automates creator fees" content from "$PROG to the moon
 * 50x ape 🚀" sentiment-only noise.
 */
export interface MentionStats {
  /** Raw count of tweets returned by the search (before relevance filtering). */
  totalMatches: number;
  /** Tweets passing the project-aligned threshold. The signal that matters. */
  alignedMatches: number;
  /** Distinct authors among aligned tweets. */
  uniqueAuthors: number;
  /** Σ log10(followers + 1) across aligned authors — caller-quality proxy.
   *  Damps bot-farm armies (many 0-follower accounts ≈ low log-sum). */
  callerFollowerLog: number;
  /** True if the project's own X handle tweeted in the last 24h. */
  projectActive: boolean;
}

const EMPTY_STATS: MentionStats = {
  totalMatches: 0,
  alignedMatches: 0,
  uniqueAuthors: 0,
  callerFollowerLog: 0,
  projectActive: false,
};

const STATS_TTL_MS = 5 * 60_000;
/** Relevance score above which we count a tweet as "aligned" (about this token). */
const ALIGNED_THRESHOLD = 25;
/** Project counts as "active" if its last tweet is within this window. */
const PROJECT_ACTIVE_MS = 24 * 60 * 60_000;

interface CacheEntry { data: MentionStats; ts: number; }

@Injectable()
export class TwitterMentionsService {
  private readonly logger = new Logger(TwitterMentionsService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(@Optional() private readonly twitter?: TwitterApiIoProvider) {}

  /**
   * Returns mention stats for a token. Aggressively cached — 5 min per
   * address — so calling this every hot scan (every 20s) doesn't blow the
   * TwitterAPI.io budget.
   *
   * Soft-fails to an empty-stats object if the provider is unavailable
   * (missing API key, network error, etc.) so the scorer can keep going.
   */
  async getMentionStats(input: {
    address: string;
    symbol: string;
    name?: string;
    projectHandle?: string | null;
    description?: string | null;
  }): Promise<MentionStats> {
    if (!this.twitter || !input.address || !input.symbol) return EMPTY_STATS;

    const cacheKey = `${input.address}:${(input.projectHandle ?? '').toLowerCase()}`;
    const hit = this.cache.get(cacheKey);
    if (hit && Date.now() - hit.ts < STATS_TTL_MS) return hit.data;

    try {
      // Search by both $TICKER and CA — TICKER catches the shill volume,
      // CA catches the definitive-proof posts (people pasting the address).
      const sym = input.symbol.toUpperCase();
      const query = `$${sym} OR ${input.address}`;
      const [tweets, projectProfile] = await Promise.all([
        this.twitter.searchTweets(query, 'Latest'),
        input.projectHandle
          ? this.twitter.fetchUserProfile(input.projectHandle)
          : Promise.resolve(null),
      ]);

      const relevanceCtx = {
        sym: input.symbol,
        fullName: input.name ?? input.symbol,
        addr: input.address,
        projectHandle: input.projectHandle ?? null,
        narrativeKeywords: extractProjectKeywords(input.description),
      };

      const aligned: TweetRich[] = [];
      for (const t of tweets) {
        if (computeTweetRelevance(t, relevanceCtx) >= ALIGNED_THRESHOLD) aligned.push(t);
      }

      const authors = new Set<string>();
      let followerLog = 0;
      for (const t of aligned) {
        if (authors.has(t.authorHandle)) continue;
        authors.add(t.authorHandle);
        followerLog += Math.log10(Math.max(t.authorFollowers, 0) + 1);
      }

      const projectActive = !!(
        projectProfile?.lastTweetAt &&
        Date.now() - projectProfile.lastTweetAt < PROJECT_ACTIVE_MS
      );

      const out: MentionStats = {
        totalMatches: tweets.length,
        alignedMatches: aligned.length,
        uniqueAuthors: authors.size,
        callerFollowerLog: Math.round(followerLog * 10) / 10,
        projectActive,
      };
      this.cache.set(cacheKey, { data: out, ts: Date.now() });
      return out;
    } catch (e: any) {
      this.logger.warn(`getMentionStats(${input.symbol}) failed: ${e.message}`);
      return EMPTY_STATS;
    }
  }

  /**
   * Convenience helper: batch over a candidate list with concurrency cap.
   * Returns a map keyed by address.
   */
  async getMentionStatsBatch(
    inputs: Array<{
      address: string;
      symbol: string;
      name?: string;
      projectHandle?: string | null;
      description?: string | null;
    }>,
    concurrency = 3,
  ): Promise<Map<string, MentionStats>> {
    const out = new Map<string, MentionStats>();
    for (let i = 0; i < inputs.length; i += concurrency) {
      const chunk = inputs.slice(i, i + concurrency);
      const results = await Promise.all(
        chunk.map((c) => this.getMentionStats(c).catch(() => EMPTY_STATS)),
      );
      results.forEach((r, idx) => { out.set(chunk[idx].address, r); });
    }
    return out;
  }
}
