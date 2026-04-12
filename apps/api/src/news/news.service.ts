import { Injectable, Logger } from '@nestjs/common';
import { http } from '../common/http';

export interface NewsItem {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  sentiment?: 'positive' | 'neutral' | 'negative';
  currencies?: string[];
}

@Injectable()
export class NewsService {
  private readonly logger = new Logger(NewsService.name);
  private cache: { items: NewsItem[]; fetchedAt: number } = { items: [], fetchedAt: 0 };
  private readonly TTL_MS = 5 * 60_000;

  async latest(limit = 20): Promise<NewsItem[]> {
    if (Date.now() - this.cache.fetchedAt < this.TTL_MS && this.cache.items.length) {
      return this.cache.items.slice(0, limit);
    }
    try {
      const apiKey = process.env.CRYPTOPANIC_API_KEY;
      if (apiKey) {
        const resp = await http.get<{ results: any[] }>(`https://cryptopanic.com/api/free/v1/posts/?auth_token=${apiKey}&kind=news&filter=important`);
        const data = resp as { results: any[] };
        this.cache.items = (data.results ?? []).slice(0, 50).map((r: any) => ({
          title: r.title,
          url: r.url,
          source: r.source?.title ?? 'Unknown',
          publishedAt: r.published_at,
          sentiment: r.votes?.positive > r.votes?.negative ? 'positive' : r.votes?.negative > r.votes?.positive ? 'negative' : 'neutral',
          currencies: r.currencies?.map((c: any) => c.code) ?? [],
        }));
      } else {
        this.cache.items = this.fallbackNews();
      }
      this.cache.fetchedAt = Date.now();
    } catch (e: any) {
      this.logger.warn(`News fetch failed: ${e.message}`);
      if (!this.cache.items.length) this.cache.items = this.fallbackNews();
    }
    return this.cache.items.slice(0, limit);
  }

  private fallbackNews(): NewsItem[] {
    return [
      { title: 'News aggregator ready — add CRYPTOPANIC_API_KEY to .env for live feed', url: '#', source: 'QWAI', publishedAt: new Date().toISOString(), sentiment: 'neutral' },
    ];
  }
}
