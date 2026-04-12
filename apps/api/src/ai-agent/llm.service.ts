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

  async chat(messages: ChatMessage[]): Promise<string> {
    const timeout = Number(process.env.LLM_TIMEOUT_MS ?? 30_000);
    return this.race(this.callProvider(messages), timeout);
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
