import { Injectable, Logger } from '@nestjs/common';
import { Chain, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from './embedding.service';

export interface DecisionContext {
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  holderCount: number | null;
  convictionScore: number | null;
  securityScore: number | null;
  sentiment: Record<string, unknown> | null;
  guardrail: { ok: boolean; reason?: string } | null;
  seed: Record<string, unknown>;
}

export interface EpisodeWriteInput {
  userId: string;
  tradeId: string | null;
  chain: Chain;
  token: string;
  side: 'buy' | 'sell';
  kind: 'EXECUTED' | 'PAPER' | 'APPROVED' | 'REJECTED';
  context: DecisionContext;
  rationale: string;
}

export interface SimilarEpisode {
  id: string;
  createdAt: Date;
  chain: Chain;
  token: string;
  side: string;
  kind: string;
  rationale: string;
  outcome1h: Record<string, unknown> | null;
  outcome24h: Record<string, unknown> | null;
  distance: number;
}

@Injectable()
export class EpisodicMemoryService {
  private readonly logger = new Logger(EpisodicMemoryService.name);

  constructor(private prisma: PrismaService, private embedding: EmbeddingService) {}

  // Persist an episode. Two-phase because Prisma can't select/insert the
  // pgvector column directly — we create the row without embedding, then
  // UPDATE the vector via raw SQL.
  async writeEpisode(input: EpisodeWriteInput): Promise<string | null> {
    try {
      const row = await this.prisma.tradeEpisode.create({
        data: {
          userId: input.userId,
          tradeId: input.tradeId,
          chain: input.chain,
          token: input.token,
          side: input.side,
          kind: input.kind,
          decisionContext: input.context as unknown as Prisma.InputJsonValue,
          rationale: input.rationale.slice(0, 800),
        },
        select: { id: true },
      });

      const embedText = this.composeEmbedText(input);
      const vec = await this.embedding.embed(embedText);
      if (vec && vec.length === 1536) {
        const vecLit = '[' + vec.join(',') + ']';
        await this.prisma.$executeRawUnsafe(
          `UPDATE "TradeEpisode" SET "embedding" = $1::vector WHERE "id" = $2`,
          vecLit,
          row.id,
        );
      }
      return row.id;
    } catch (e: any) {
      this.logger.warn(`writeEpisode user=${input.userId} failed: ${e.message}`);
      return null;
    }
  }

  async findSimilar(
    userId: string,
    query: { chain?: Chain; token?: string; side?: 'buy' | 'sell'; rawText?: string; context?: DecisionContext },
    k = 5,
  ): Promise<SimilarEpisode[]> {
    if (process.env.EPISODIC_MEMORY_ENABLED !== 'true') return [];
    if (!this.embedding.isAvailable()) return [];
    const text = query.rawText ?? this.composeEmbedText({
      userId,
      tradeId: null,
      chain: query.chain ?? Chain.SOLANA,
      token: query.token ?? '',
      side: query.side ?? 'buy',
      kind: 'EXECUTED',
      context: query.context ?? emptyContext(),
      rationale: '',
    });
    const vec = await this.embedding.embed(text);
    if (!vec || vec.length !== 1536) return [];
    const vecLit = '[' + vec.join(',') + ']';
    try {
      const rows = await this.prisma.$queryRawUnsafe<Array<{
        id: string;
        createdAt: Date;
        chain: Chain;
        token: string;
        side: string;
        kind: string;
        rationale: string;
        outcome1h: any;
        outcome24h: any;
        distance: number;
      }>>(
        `SELECT id, "createdAt", chain, token, side, kind, rationale,
                "outcome1h", "outcome24h",
                (embedding <=> $1::vector) AS distance
         FROM "TradeEpisode"
         WHERE "userId" = $2
           AND "outcome1h" IS NOT NULL
           AND embedding IS NOT NULL
         ORDER BY embedding <=> $1::vector
         LIMIT $3`,
        vecLit,
        userId,
        k,
      );
      return rows;
    } catch (e: any) {
      this.logger.warn(`findSimilar failed user=${userId}: ${e.message}`);
      return [];
    }
  }

  compactForPrompt(eps: SimilarEpisode[]): string {
    if (!eps.length) return '(none yet)';
    return eps.map((e) => {
      const out1 = asOutcome(e.outcome1h);
      const out24 = asOutcome(e.outcome24h);
      const when = humanAgo(e.createdAt);
      const pct = (n: number | null) => (n == null ? '?' : `${n > 0 ? '+' : ''}${n.toFixed(1)}%`);
      return `[${when}] ${e.side} ${e.token} on ${e.chain} → ${pct(out1.priceDeltaPct)} in 1h${out24.priceDeltaPct != null ? `, ${pct(out24.priceDeltaPct)} in 24h` : ''} — "${e.rationale.slice(0, 120)}"`;
    }).join('\n');
  }

  private composeEmbedText(input: EpisodeWriteInput): string {
    const c = input.context ?? emptyContext();
    return [
      input.kind,
      String(input.chain),
      input.token,
      input.side,
      `price=${c.priceUsd ?? '?'}`,
      `mcap=${c.marketCapUsd ?? '?'}`,
      `liq=${c.liquidityUsd ?? '?'}`,
      `holders=${c.holderCount ?? '?'}`,
      `conviction=${c.convictionScore ?? '?'}`,
      `security=${c.securityScore ?? '?'}`,
      input.rationale.slice(0, 300),
    ].join(' | ');
  }
}

function emptyContext(): DecisionContext {
  return {
    priceUsd: null, marketCapUsd: null, liquidityUsd: null, holderCount: null,
    convictionScore: null, securityScore: null, sentiment: null, guardrail: null, seed: {},
  };
}

function asOutcome(raw: any): { priceDeltaPct: number | null } {
  if (!raw || typeof raw !== 'object') return { priceDeltaPct: null };
  const p = Number((raw as any).priceDeltaPct);
  return { priceDeltaPct: Number.isFinite(p) ? p : null };
}

function humanAgo(d: Date): string {
  const ms = Date.now() - d.getTime();
  const h = ms / 3600_000;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))}m ago`;
  if (h < 24) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
