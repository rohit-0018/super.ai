import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';

// Thin wrapper around OpenAI embeddings. text-embedding-3-small is the
// cheapest 1536-d model and matches the pgvector column width. Returns
// null (not throws) when OPENAI_API_KEY is unset so L2 writes still land
// with NULL embeddings — they just won't be retrievable by RAG.
@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private readonly model = process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small';
  private readonly openai = process.env.OPENAI_API_KEY
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    : null;

  isAvailable(): boolean {
    return !!this.openai;
  }

  async embed(text: string): Promise<number[] | null> {
    if (!this.openai) return null;
    const trimmed = text.length > 6000 ? text.slice(0, 6000) : text;
    try {
      const r = await this.openai.embeddings.create({ model: this.model, input: trimmed });
      return r.data[0].embedding;
    } catch (e: any) {
      this.logger.warn(`embed failed: ${e.message}`);
      return null;
    }
  }

  async embedBatch(texts: string[]): Promise<(number[] | null)[]> {
    if (!this.openai || texts.length === 0) return texts.map(() => null);
    try {
      const r = await this.openai.embeddings.create({ model: this.model, input: texts });
      return r.data.map((d) => d.embedding);
    } catch (e: any) {
      this.logger.warn(`embed batch failed: ${e.message}`);
      return texts.map(() => null);
    }
  }
}
