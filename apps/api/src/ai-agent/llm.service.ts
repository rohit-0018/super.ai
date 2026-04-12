import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }

@Injectable()
export class LlmService {
  private logger = new Logger(LlmService.name);
  private provider = (process.env.LLM_PROVIDER ?? 'anthropic').toLowerCase();
  private anthropic = process.env.ANTHROPIC_API_KEY
    ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    : null;
  private openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

  private responseCache = new Map<string, { result: string; ts: number }>();
  private readonly CACHE_TTL = 5 * 60_000;

  async chat(messages: ChatMessage[]): Promise<string> {
    const key = this.cacheKey(messages);
    const cached = this.responseCache.get(key);
    if (cached && Date.now() - cached.ts < this.CACHE_TTL) {
      this.logger.debug('LLM cache hit');
      return cached.result;
    }
    const timeout = Number(process.env.LLM_TIMEOUT_MS ?? 30_000);
    const result = await this.race(this.callProvider(messages), timeout);
    this.responseCache.set(key, { result, ts: Date.now() });
    if (this.responseCache.size > 200) {
      const oldest = [...this.responseCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
      if (oldest) this.responseCache.delete(oldest[0]);
    }
    return result;
  }

  private cacheKey(messages: ChatMessage[]): string {
    const last3 = messages.slice(-3).map((m) => `${m.role}:${m.content.slice(0, 100)}`).join('|');
    return last3;
  }

  async *stream(messages: ChatMessage[]): AsyncGenerator<string> {
    if (this.provider === 'anthropic' && this.anthropic) {
      const sys = messages.find((m) => m.role === 'system')?.content;
      const rest = messages.filter((m) => m.role !== 'system') as { role: 'user' | 'assistant'; content: string }[];
      const stream = this.anthropic.messages.stream({
        model: process.env.LLM_MODEL ?? 'claude-opus-4-6',
        max_tokens: 1024,
        system: sys,
        messages: rest,
      });
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && (event.delta as any).text) {
          yield (event.delta as any).text as string;
        }
      }
      return;
    }
    yield await this.chat(messages);
  }

  private async callProvider(messages: ChatMessage[]): Promise<string> {
    if (this.provider === 'anthropic' && this.anthropic) {
      const sys = messages.find((m) => m.role === 'system')?.content;
      const rest = messages.filter((m) => m.role !== 'system') as { role: 'user' | 'assistant'; content: string }[];
      const r = await this.anthropic.messages.create({
        model: process.env.LLM_MODEL ?? 'claude-opus-4-6',
        max_tokens: 1024,
        system: sys,
        messages: rest,
      });
      return r.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    }
    if (this.openai) {
      const r = await this.openai.chat.completions.create({
        model: process.env.LLM_MODEL ?? 'gpt-4o',
        messages,
      });
      return r.choices[0]?.message?.content ?? '';
    }
    this.logger.error(
      'No LLM provider configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env (and LLM_PROVIDER accordingly).',
    );
    throw new Error(
      'LLM provider not configured. Add ANTHROPIC_API_KEY (or OPENAI_API_KEY) to your .env and restart the API.',
    );
  }

  private race<T>(p: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_, rej) => setTimeout(() => rej(new Error('LLM timeout')), ms)),
    ]);
  }
}
