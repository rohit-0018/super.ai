import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface ComparableToken {
  address: string;
  symbol: string | null;
  name: string | null;
  chain: string;
  marketCapUsd: number | null;
  aiScore: number | null;
  aiVerdict: string | null;
  ageHoursAtScan: number | null;
  scannedAt: string;            // ISO
  url: string | null;           // DexScreener link
}

/**
 * Finds recently scanned tokens similar in age + market cap to the current one.
 * Used in the Full Dossier report for context ("how did similar tokens perform?").
 */
@Injectable()
export class ComparableTokensService {
  private readonly logger = new Logger(ComparableTokensService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findComparables(
    chain: string,
    address: string,
    marketCapUsd: number | null,
    pairAgeHours: number | null,
  ): Promise<ComparableToken[]> {
    try {
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      // Wide range query — filter in memory for flexibility
      const rows = await this.prisma.tokenIntel.findMany({
        where: {
          chain: chain as any,
          address: { not: address },
          aiAnalyzedAt: { gte: cutoff },
          aiScore: { not: null },
          fullReport: { not: Prisma.AnyNull },
        },
        select: {
          address: true,
          symbol: true,
          name: true,
          chain: true,
          aiScore: true,
          aiVerdict: true,
          fullReport: true,
          aiAnalyzedAt: true,
        },
        orderBy: { aiAnalyzedAt: 'desc' },
        take: 200,
      });

      const comparables: ComparableToken[] = [];

      for (const row of rows) {
        const report = row.fullReport as any;
        const mcap: number | null = report?.meta?.marketCapUsd ?? null;
        const age: number | null = report?.meta?.pairAgeHours ?? null;
        const url: string | null = report?.meta?.url ?? null;

        // Filter: similar market cap (within 5x range) and age (within 3x range)
        const mcapMatch = !marketCapUsd || !mcap || (mcap > marketCapUsd / 5 && mcap < marketCapUsd * 5);
        const ageMatch = !pairAgeHours || !age || (age > pairAgeHours / 3 && age < pairAgeHours * 3);

        if (mcapMatch && ageMatch) {
          comparables.push({
            address: row.address,
            symbol: row.symbol,
            name: row.name,
            chain: row.chain,
            marketCapUsd: mcap,
            aiScore: row.aiScore,
            aiVerdict: row.aiVerdict,
            ageHoursAtScan: age,
            scannedAt: row.aiAnalyzedAt?.toISOString() ?? new Date().toISOString(),
            url,
          });

          if (comparables.length >= 6) break;
        }
      }

      return comparables;
    } catch (e: any) {
      this.logger.warn(`Comparable tokens query failed: ${e.message}`);
      return [];
    }
  }
}
