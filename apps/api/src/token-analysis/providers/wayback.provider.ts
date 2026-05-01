import { Injectable, Logger } from '@nestjs/common';

/**
 * Wayback Machine (archive.org) — free, no auth.
 * Checks whether a token's website has significant historical snapshots,
 * and flags if recent changes occurred (could indicate bait-and-switch).
 *
 * Uses the Availability API: https://archive.org/wayback/available?url=...
 * Rate limit: conservative 10/min.
 */
@Injectable()
export class WaybackProvider {
  private readonly logger = new Logger(WaybackProvider.name);

  async checkWebsite(url: string): Promise<{ snapshotCount: number; latestSnapshotDate: string | null; changed: boolean } | null> {
    if (!url) return null;
    try {
      const hostname = new URL(url).hostname;

      // Check availability (free, fast)
      const availRes = await fetch(
        `https://archive.org/wayback/available?url=${encodeURIComponent(hostname)}`,
        { signal: AbortSignal.timeout(5_000), headers: { 'User-Agent': 'qwai/1.0' } },
      );
      if (!availRes.ok) return null;
      const avail = await availRes.json() as any;
      const nearest = avail?.archived_snapshots?.closest;
      if (!nearest?.available) {
        return { snapshotCount: 0, latestSnapshotDate: null, changed: false };
      }

      const latestSnapshotDate = nearest.timestamp
        ? `${nearest.timestamp.slice(0, 4)}-${nearest.timestamp.slice(4, 6)}-${nearest.timestamp.slice(6, 8)}`
        : null;

      // Count snapshots via CDX API (free, no auth)
      const cdxRes = await fetch(
        `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(hostname)}&output=json&limit=1&showNumPages=true`,
        { signal: AbortSignal.timeout(5_000), headers: { 'User-Agent': 'qwai/1.0' } },
      );
      let snapshotCount = 0;
      if (cdxRes.ok) {
        const cdxBody = await cdxRes.json() as any;
        if (Array.isArray(cdxBody) && cdxBody.length > 0) {
          snapshotCount = parseInt(cdxBody[0] ?? '0', 10) || 0;
        }
      }

      // "changed" = website existed before but has fewer recent snapshots
      // (could indicate domain flip or major change)
      const changed = snapshotCount > 5 && !!latestSnapshotDate &&
        new Date(latestSnapshotDate) > new Date(Date.now() - 30 * 86400 * 1000);

      return { snapshotCount, latestSnapshotDate, changed };
    } catch (e: any) {
      this.logger.debug(`Wayback check failed for ${url}: ${e.message}`);
      return null;
    }
  }
}
