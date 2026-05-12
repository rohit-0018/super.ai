import { Injectable, Logger } from '@nestjs/common';
import { normalizeTweet, type TweetRich } from './twitter-relevance';

/**
 * TwitterAPI.io HTTP client. Wraps the four endpoints we actually use:
 *   - advanced tweet search (Top/Latest)
 *   - single tweet by ID
 *   - user profile (info)
 *   - user's recent tweets
 *
 * Two cache layers:
 *   - search results / single-tweet: 60s TTL (price-action signals; need recency)
 *   - user profile + last_tweets: 5min TTL (rarely changes that fast)
 *
 * All methods soft-fail (return null/empty on error) so callers don't need to
 * handle network exceptions. No backoff/retry yet — the hot-tokens scanner is
 * the heaviest caller and already throttles concurrency.
 */

export interface UserProfile {
  handle: string;
  bio: string;
  followers: number;
  lastTweets: string[];
  /** Most recent tweet timestamp (ms) — useful for "is this account still active?" checks. */
  lastTweetAt: number | null;
}

const SEARCH_TTL_MS  = 60_000;
const PROFILE_TTL_MS = 5 * 60_000;
/** Hard global rate budget — protects the TwitterAPI.io plan from runaway
 *  callers (e.g. a regressed scan loop fanning out for every token). When
 *  exceeded, methods soft-fail to empty/null so the rest of the pipeline keeps
 *  flowing. Tunable via env. */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_CALLS = parseInt(process.env.TWITTER_API_IO_MAX_CALLS_PER_MIN ?? '60', 10);

interface CacheEntry<T> { data: T; ts: number; }

@Injectable()
export class TwitterApiIoProvider {
  private readonly logger = new Logger(TwitterApiIoProvider.name);
  private readonly base = 'https://api.twitterapi.io';

  private readonly searchCache  = new Map<string, CacheEntry<TweetRich[]>>();
  private readonly tweetCache   = new Map<string, CacheEntry<TweetRich | null>>();
  private readonly profileCache = new Map<string, CacheEntry<UserProfile | null>>();

  // Sliding-window call counter: timestamps of HTTP calls within RATE_WINDOW_MS.
  private callTimes: number[] = [];
  private rateWarnedAt = 0;

  /** True if we'd exceed the budget by making one more call right now. */
  private overBudget(): boolean {
    const cutoff = Date.now() - RATE_WINDOW_MS;
    this.callTimes = this.callTimes.filter((t) => t > cutoff);
    if (this.callTimes.length >= RATE_MAX_CALLS) {
      const now = Date.now();
      if (now - this.rateWarnedAt > 30_000) {
        this.rateWarnedAt = now;
        this.logger.warn(
          `TwitterAPI.io rate budget hit (${this.callTimes.length}/${RATE_MAX_CALLS} per ${RATE_WINDOW_MS / 1000}s) — soft-failing further calls`,
        );
      }
      return true;
    }
    return false;
  }

  private recordCall(): void { this.callTimes.push(Date.now()); }

  /** Used by callers / health checks to inspect usage without making a request. */
  callsLastMinute(): number {
    const cutoff = Date.now() - RATE_WINDOW_MS;
    this.callTimes = this.callTimes.filter((t) => t > cutoff);
    return this.callTimes.length;
  }

  private get key(): string | null {
    return process.env.TWITTER_API_IO_KEY ?? null;
  }

  private get headers(): Record<string, string> {
    const k = this.key;
    return k ? { 'X-API-Key': k, Accept: 'application/json' } : { Accept: 'application/json' };
  }

  private cacheGet<T>(map: Map<string, CacheEntry<T>>, key: string, ttl: number): T | undefined {
    const hit = map.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.ts > ttl) { map.delete(key); return undefined; }
    return hit.data;
  }

  /**
   * Engagement-sorted advanced search. queryType='Top' is the catalyst-hunt
   * default; 'Latest' for recency-sensitive use cases (velocity counts).
   */
  async searchTweets(query: string, queryType: 'Top' | 'Latest' = 'Top'): Promise<TweetRich[]> {
    if (!this.key) return [];
    const cacheKey = `${queryType}:${query}`;
    const hit = this.cacheGet(this.searchCache, cacheKey, SEARCH_TTL_MS);
    if (hit) return hit;
    if (this.overBudget()) return [];
    this.recordCall();
    try {
      const res = await fetch(
        `${this.base}/twitter/tweet/advanced_search?query=${encodeURIComponent(query)}&queryType=${queryType}`,
        { headers: this.headers, signal: AbortSignal.timeout(8_000) },
      );
      if (!res.ok) return [];
      const body = await res.json() as any;
      const raw: any[] = body?.data?.tweets ?? body?.tweets ?? [];
      const out = raw.map(normalizeTweet).filter((t): t is TweetRich => t != null);
      this.searchCache.set(cacheKey, { data: out, ts: Date.now() });
      return out;
    } catch (e: any) {
      this.logger.warn(`searchTweets failed (${query}): ${e.message}`);
      return [];
    }
  }

  /** Fetch a single tweet by ID — used to honor DexScreener-pinned /status/<id> URLs. */
  async fetchTweetById(id: string): Promise<TweetRich | null> {
    if (!this.key || !id) return null;
    const hit = this.cacheGet(this.tweetCache, id, SEARCH_TTL_MS);
    if (hit !== undefined) return hit;
    if (this.overBudget()) return null;
    this.recordCall();
    try {
      const res = await fetch(
        `${this.base}/twitter/tweets?tweet_ids=${encodeURIComponent(id)}`,
        { headers: this.headers, signal: AbortSignal.timeout(6_000) },
      );
      if (!res.ok) { this.tweetCache.set(id, { data: null, ts: Date.now() }); return null; }
      const body = await res.json() as any;
      const t = (body?.tweets ?? body?.data?.tweets ?? [])[0];
      const out = t ? normalizeTweet(t) : null;
      this.tweetCache.set(id, { data: out, ts: Date.now() });
      return out;
    } catch (e: any) {
      this.logger.warn(`fetchTweetById(${id}) failed: ${e.message}`);
      return null;
    }
  }

  /** Fetch user profile + recent tweets in a single call. Cached 5 min. */
  async fetchUserProfile(handle: string): Promise<UserProfile | null> {
    if (!this.key || !handle) return null;
    const key = handle.toLowerCase();
    const hit = this.cacheGet(this.profileCache, key, PROFILE_TTL_MS);
    if (hit !== undefined) return hit;
    // Profile fetch hits TWO endpoints; reserve budget for both.
    if (this.overBudget()) return null;
    this.recordCall();
    this.recordCall();
    try {
      const [profileRes, tweetsRes] = await Promise.all([
        fetch(`${this.base}/twitter/user/info?userName=${encodeURIComponent(handle)}`,
          { headers: this.headers, signal: AbortSignal.timeout(6_000) }),
        fetch(`${this.base}/twitter/user/last_tweets?userName=${encodeURIComponent(handle)}`,
          { headers: this.headers, signal: AbortSignal.timeout(8_000) }),
      ]);
      const p = profileRes.ok ? (await profileRes.json() as any)?.data : null;
      const tweetsBody = tweetsRes.ok ? await tweetsRes.json() as any : null;
      const rawTweets: any[] = tweetsBody?.data?.tweets ?? tweetsBody?.tweets ?? [];
      const lastTweets = rawTweets
        .map((t: any) => (t.text ?? t.full_text ?? '').replace(/https?:\/\/\S+/g, '').trim())
        .filter((t: string) => t.length > 20)
        .slice(0, 8);
      const lastTweetAt = rawTweets.length
        ? Math.max(...rawTweets.map((t: any) => new Date(t.createdAt ?? t.created_at ?? 0).getTime()).filter(Number.isFinite))
        : null;
      if (!p && !lastTweets.length) {
        this.profileCache.set(key, { data: null, ts: Date.now() });
        return null;
      }
      const out: UserProfile = {
        handle,
        bio: (p?.description ?? '').slice(0, 200),
        followers: Number(p?.followers_count ?? p?.followers ?? 0),
        lastTweets,
        lastTweetAt: lastTweetAt && Number.isFinite(lastTweetAt) ? lastTweetAt : null,
      };
      this.profileCache.set(key, { data: out, ts: Date.now() });
      return out;
    } catch (e: any) {
      this.logger.warn(`fetchUserProfile @${handle} failed: ${e.message}`);
      return null;
    }
  }
}
