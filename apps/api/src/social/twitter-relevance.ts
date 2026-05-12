/**
 * Twitter-relevance scoring + tweet normalization. Pure functions extracted
 * from the Telegram /lore command so the hot-tokens scanner and any future
 * social pillar can reuse them.
 *
 * The fundamental problem these utilities solve: 4-letter tickers like
 * PROG / MOON / BABY / AI collide with common English ("prog rock", "to the
 * moon"). A bare cashtag/keyword search returns a lot of false positives
 * that LOOK like high engagement but aren't actually about the token. The
 * relevance score lets us filter to "tweets that are clearly about THIS
 * token" before ranking or counting.
 */

/** Engagement-rich tweet shape — agnostic to twitterapi.io's field-name drift. */
export type TweetRich = {
  id: string;
  text: string;
  url: string;
  authorHandle: string;
  authorFollowers: number;
  authorVerified: boolean;
  likes: number;
  retweets: number;
  replies: number;
  views: number;
  createdAt: number; // ms epoch
  inReplyToId: string | null;
  inReplyToUsername: string | null;
  /** True when this entry was synthesized from a reply-cluster (catalyst was likely deleted). */
  isReconstructed?: boolean;
};

export type LoreBudget = 'light' | 'balanced' | 'aggressive';

export interface RelevanceContext {
  sym: string;
  fullName: string;
  addr: string | null;
  projectHandle: string | null;
  /** Bag of distinctive keywords from the project's own description sources. */
  narrativeKeywords?: Set<string>;
}

/**
 * Parse a twitter/x.com URL. Distinguishes profile URLs from tweet permalinks.
 *   https://x.com/elonmusk → { handle: 'elonmusk', tweetId: null }
 *   https://x.com/solus/status/2053355 → { handle: 'solus', tweetId: '2053355' }
 */
export function parseTwitterUrl(url: string): { handle: string | null; tweetId: string | null } {
  const statusMatch = url.match(/(?:twitter|x)\.com\/([^/?#]+)\/status\/(\d+)/);
  if (statusMatch) return { handle: statusMatch[1], tweetId: statusMatch[2] };
  const handleMatch = url.match(/(?:twitter|x)\.com\/([^/?#]+)/);
  return { handle: handleMatch?.[1] ?? null, tweetId: null };
}

/** twitterapi.io returns slightly different field names across endpoints — normalize defensively. */
export function normalizeTweet(t: any): TweetRich | null {
  const id = t?.id ?? t?.id_str ?? t?.tweet_id;
  const author = t?.author ?? t?.user ?? {};
  const handle = author?.userName ?? author?.screen_name ?? author?.username;
  if (!id || !handle) return null;
  const text = (t.text ?? t.full_text ?? '').replace(/https?:\/\/\S+/g, '').trim();
  if (text.length < 10) return null;
  const createdRaw = t.createdAt ?? t.created_at;
  const createdAt = createdRaw ? new Date(createdRaw).getTime() : Date.now();
  return {
    id: String(id),
    text,
    url: `https://x.com/${handle}/status/${id}`,
    authorHandle: String(handle),
    authorFollowers: Number(author.followers ?? author.followers_count ?? 0),
    authorVerified: !!(author.isBlueVerified ?? author.verified),
    likes: Number(t.likeCount ?? t.like_count ?? t.favorite_count ?? 0),
    retweets: Number(t.retweetCount ?? t.retweet_count ?? 0),
    replies: Number(t.replyCount ?? t.reply_count ?? 0),
    views: Number(t.viewCount ?? t.view_count ?? 0),
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    inReplyToId: t.inReplyToId || t.in_reply_to_status_id || t.in_reply_to_status_id_str || null,
    inReplyToUsername: t.inReplyToUsername || t.in_reply_to_screen_name || null,
  };
}

/** Words we strip from project descriptions when extracting narrative keywords — appear in every shill. */
export const NARRATIVE_STOPWORDS = new Set([
  // English stopwords
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
  'this', 'that', 'these', 'those', 'with', 'from', 'into', 'onto', 'upon', 'about', 'as',
  'at', 'by', 'for', 'in', 'of', 'on', 'to', 'via', 'than', 'then', 'them', 'they', 'their',
  'your', 'you', 'our', 'we', 'us', 'it', 'its', 'his', 'her', 'him', 'she', 'he',
  'not', 'no', 'yes', 'all', 'any', 'each', 'every', 'some', 'such', 'one', 'two',
  // Crypto-generic noise
  'token', 'tokens', 'coin', 'coins', 'crypto', 'solana', 'ethereum', 'sol', 'eth',
  'pump', 'pumpfun', 'fun', 'dex', 'cex', 'memecoin', 'meme', 'degen',
  'buy', 'sell', 'hold', 'launch', 'launched', 'launching',
  'chart', 'price', 'market', 'mcap',
]);

/** Used by computeTweetRelevance to validate cashtag context — filters "$prog album" type noise. */
export const CRYPTO_CONTEXT_RE = /\b(token|coin|pump\.?fun|solana|sol\b|raydium|jupiter|cashtag|ca:|contract|degen|memecoin|liquidity|mcap|market\s*cap|airdrop|launch|chart|dyor|ath)\b/i;

/**
 * Extract a bag of "project-specific" keywords from authoritative project
 * description sources (pump.fun description, CoinGecko description, website).
 * These keywords distinguish tweets that talk about WHAT THE PROJECT DOES from
 * tweets that just shill the ticker for price action.
 */
export function extractProjectKeywords(...sources: (string | null | undefined)[]): Set<string> {
  const bag = new Set<string>();
  for (const src of sources) {
    if (!src) continue;
    const words = src
      .toLowerCase()
      .replace(/<[^>]+>/g, ' ')
      .replace(/https?:\/\/\S+/g, ' ')
      .split(/[^a-z0-9]+/)
      .filter(w => w.length >= 4 && !NARRATIVE_STOPWORDS.has(w));
    for (const w of words) bag.add(w);
  }
  return bag;
}

/**
 * Score how likely a tweet is actually about THIS token vs. coincidental
 * keyword noise.
 *
 * Strong signals (definitive): CA in tweet text, project-handle authorship,
 * full multi-word project name match.
 * Medium signals: cashtag + crypto context word, reply to project handle.
 * Weak signals: bare ticker alone — explicitly NOT enough to qualify.
 */
export function computeTweetRelevance(t: TweetRich, ctx: RelevanceContext): number {
  const text = t.text.toLowerCase();
  const sym = ctx.sym.toLowerCase();
  const handle = ctx.projectHandle?.toLowerCase() ?? null;
  let r = 0;

  // (A) CA in tweet body — definitive proof it's about this token.
  if (ctx.addr && text.includes(ctx.addr.toLowerCase())) r += 100;

  // (B) $TICKER cashtag.
  const cashtag = new RegExp(`\\$${sym}\\b`, 'i').test(t.text);
  if (cashtag) r += 30;
  if (cashtag && CRYPTO_CONTEXT_RE.test(t.text)) r += 25;

  // (C) Project handle is the author, or the tweet is a reply/quote to them.
  if (handle) {
    if (t.authorHandle.toLowerCase() === handle) r += 50;
    if (text.includes(`@${handle}`)) r += 20;
    if (t.inReplyToUsername?.toLowerCase() === handle) r += 25;
  }

  // (D) Distinctive project name match — contiguous phrase only (after
  // stripping punctuation/spaces), not just both words anywhere in the tweet.
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const normText = norm(t.text);
  const normName = norm(ctx.fullName ?? '');
  const nameWords = (ctx.fullName ?? '').split(/\s+/).filter(w => w.length >= 4);
  if (nameWords.length >= 2 && normName.length >= 8 && normText.includes(normName)) {
    r += 40;
  } else if (nameWords.length === 1 && normName.length >= 8 && /[A-Z]/.test(ctx.fullName)) {
    if (normText.includes(normName)) r += 25;
  }

  // (E) Narrative overlap — share project-specific vocabulary with the
  // authoritative description? Separates "$PROG automates creator fees"
  // (high overlap) from "$PROG 50x ape 🚀" (zero overlap).
  if (ctx.narrativeKeywords && ctx.narrativeKeywords.size > 0) {
    const tweetWords = new Set(
      text
        .replace(/https?:\/\/\S+/g, ' ')
        .split(/[^a-z0-9]+/)
        .filter(w => w.length >= 4 && !NARRATIVE_STOPWORDS.has(w)),
    );
    let overlap = 0;
    for (const k of ctx.narrativeKeywords) {
      if (tweetWords.has(k)) overlap++;
      if (overlap >= 5) break;
    }
    if (overlap >= 5) r += 50;
    else if (overlap >= 3) r += 30;
    else if (overlap >= 2) r += 15;
  }

  return r;
}

/**
 * Picks an origin tweet (oldest with real signal, ideally within token launch
 * window), engagement-ranked amplifiers (deduped by author), and remaining
 * community-vibe tweets. Tweets below the relevance noise floor are excluded
 * from every pool.
 */
export function rankTweetsForLore(
  tweets: TweetRich[],
  tokenCreatedAt: number | null,
  relevanceCtx: RelevanceContext,
): { origin: TweetRich | null; amplifiers: TweetRich[]; community: TweetRich[] } {
  const seen = new Set<string>();
  const unique = tweets.filter(t => (seen.has(t.id) ? false : (seen.add(t.id), true)));

  const withRelevance = unique.map(t => ({
    t,
    relevance: t.isReconstructed ? 100 : computeTweetRelevance(t, relevanceCtx),
  }));

  const ORIGIN_THRESHOLD    = 30;
  const AMPLIFIER_THRESHOLD = 25;
  const COMMUNITY_THRESHOLD = 15;

  const score = (t: TweetRich) =>
    t.likes + 2 * t.retweets + 3 * t.replies + Math.log10(Math.max(t.authorFollowers, 1)) * 100;

  const HIGH_ENGAGEMENT = 500;
  const BIG_AUTHOR = 100_000;
  const PRELAUNCH_MS  = 90 * 86_400_000;
  const POSTLAUNCH_MS =  7 * 86_400_000;

  const inWindow = (t: TweetRich) =>
    !tokenCreatedAt ||
    (t.createdAt >= tokenCreatedAt - PRELAUNCH_MS && t.createdAt <= tokenCreatedAt + POSTLAUNCH_MS);

  const highSignal = withRelevance
    .filter(({ relevance }) => relevance >= ORIGIN_THRESHOLD)
    .map(({ t }) => t)
    .filter(t => t.likes >= HIGH_ENGAGEMENT || t.authorFollowers >= BIG_AUTHOR || t.isReconstructed)
    .filter(inWindow);

  const preLaunch = tokenCreatedAt
    ? highSignal.filter(t => t.createdAt <= tokenCreatedAt).sort((a, b) => score(b) - score(a))
    : [];
  const postLaunchOrAll = highSignal
    .filter(t => !tokenCreatedAt || t.createdAt > tokenCreatedAt)
    .sort((a, b) => score(b) - score(a));
  const origin = preLaunch[0] ?? postLaunchOrAll[0] ?? null;

  const dedupAuthor = new Map<string, TweetRich>();
  const amplifierPool = withRelevance
    .filter(({ relevance }) => relevance >= AMPLIFIER_THRESHOLD)
    .map(({ t }) => t)
    .sort((a, b) => score(b) - score(a));
  for (const t of amplifierPool) {
    if (origin && t.id === origin.id) continue;
    if (!dedupAuthor.has(t.authorHandle)) dedupAuthor.set(t.authorHandle, t);
  }
  const amplifiers = [...dedupAuthor.values()].slice(0, 5);

  const used = new Set<string>([origin?.id, ...amplifiers.map(t => t.id)].filter(Boolean) as string[]);
  const community = withRelevance
    .filter(({ t, relevance }) => relevance >= COMMUNITY_THRESHOLD && !used.has(t.id))
    .map(({ t }) => t)
    .slice(0, 5);

  return { origin, amplifiers, community };
}
